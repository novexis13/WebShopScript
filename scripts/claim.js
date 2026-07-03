import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SHOP_URL = process.env.SHOP_URL ?? 'https://slvshop.netmarble.com/ja/item';
const STORAGE_STATE_PATH = process.env.STORAGE_STATE_PATH ?? 'storage/state.json';
const HEADLESS = process.env.HEADLESS !== 'false';
const DRY_RUN = process.env.DRY_RUN === 'true';
const SLOW_MO = Number(process.env.SLOW_MO ?? 0);
const PAUSE_AFTER_DONE = Number(process.env.PAUSE_AFTER_DONE ?? 0);
const NETMARBLE_EMAIL = process.env.NETMARBLE_EMAIL ?? '';
const NETMARBLE_PASSWORD = process.env.NETMARBLE_PASSWORD ?? '';

// 受け取り対象は、商品名指定または daily/weekly の頻度指定で受け取ります。
const targets = parseTargets(process.argv.slice(2));

if (targets.length === 0) {
  console.error('No target specified. Use --frequency daily or --item "商品名".');
  process.exit(2);
}

const hasSavedLoginState = fs.existsSync(STORAGE_STATE_PATH);
const hasLoginCredentials = Boolean(NETMARBLE_EMAIL && NETMARBLE_PASSWORD);

// 保存済みセッションを優先し、なければ GitHub Secrets の認証情報でログインします。
if (!hasSavedLoginState && !hasLoginCredentials) {
  console.error(`Missing login state: ${STORAGE_STATE_PATH}`);
  console.error('Run `npm run login`, or set NETMARBLE_EMAIL and NETMARBLE_PASSWORD.');
  process.exit(2);
}

const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOW_MO });
const context = await browser.newContext({
  // ショップ表示とリセット時間に合わせて、日本向けの環境で開きます。
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
  ...(hasSavedLoginState ? { storageState: STORAGE_STATE_PATH } : {}),
});
const page = await context.newPage();

try {
  page.setDefaultTimeout(20_000);
  await gotoShop(page);
  await dismissCommonPopups(page);
  await ensureLoggedIn(page);

  for (const target of targets) {
    if (target.type === 'frequency') {
      console.log(`\n== Claiming ${target.frequency} free rewards ==`);
      await claimFrequency(page, target.frequency);
    } else {
      console.log(`\n== Claiming: ${target.itemName} ==`);
      await claimItem(page, target.itemName);
    }
  }
} catch (error) {
  console.error('\nClaim failed.');
  console.error(error?.stack || error);
  await logDebugState(page);
  process.exitCode = 1;
} finally {
  if (PAUSE_AFTER_DONE > 0) {
    console.log(`Waiting ${PAUSE_AFTER_DONE}ms before closing the browser...`);
    await page.waitForTimeout(PAUSE_AFTER_DONE).catch(() => {});
  }
  await browser.close();
}

function parseTargets(args) {
  // --frequency と --item を複数指定できるようにして、まとめて受け取れるようにします。
  const parsed = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--item' && args[index + 1]) {
      parsed.push({ type: 'item', itemName: args[index + 1] });
      index += 1;
      continue;
    }

    if (args[index] === '--frequency' && args[index + 1]) {
      const frequency = args[index + 1].toLowerCase();
      if (!['daily', 'weekly'].includes(frequency)) {
        throw new Error(`Unsupported frequency: ${frequency}`);
      }

      parsed.push({ type: 'frequency', frequency });
      index += 1;
    }
  }

  if (process.env.ITEM_NAMES) {
    parsed.push(
      ...process.env.ITEM_NAMES.split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((itemName) => ({ type: 'item', itemName })),
    );
  }

  const seen = new Set();
  return parsed.filter((target) => {
    const key = target.type === 'frequency' ? `frequency:${target.frequency}` : `item:${target.itemName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function gotoShop(page) {
  await page.goto(SHOP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
}

async function claimItem(page, itemName) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await gotoShop(page);
    await dismissCommonPopups(page);

    // まず商品名を見つけ、その周辺にあるクリック可能な商品カードを探します。
    const itemText = page.getByText(itemName, { exact: false }).first();
    await itemText.waitFor({ state: 'visible' });
    await itemText.scrollIntoViewIfNeeded();

    const card = itemText.locator(
      'xpath=ancestor::*[self::li or self::article or self::section or self::div][.//button or @role="button" or .//a][1]',
    );

    const cardText = normalize(await card.innerText().catch(() => ''));
    // 有料商品を誤クリックしないよう、無料受け取りに見える場合だけ先へ進みます。
    assertFreeClaimSurface(itemName, cardText);

    const action = await findActionIn(card);
    if (!action) {
      throw new Error(`Could not find a free claim button for "${itemName}". Card text: ${cardText}`);
    }

    const actionText = normalize(await action.innerText().catch(() => ''));
    console.log(`Action: ${actionText || '<icon/button>'}`);

    if (isCompletedText(actionText)) {
      console.log(`Already completed: ${itemName}`);
      return;
    }

    if (DRY_RUN) {
      console.log('DRY_RUN=true, skipping click.');
      return;
    }

    await action.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await dismissCommonPopups(page);

    if (await pageShowsLoginRequired(page)) {
      if (attempt === 2) {
        throw new Error('Login is still required after automatic login.');
      }

      console.log('Login required. Trying automatic login...');
      await loginWithCredentials(page);
      continue;
    }

    const confirmResult = await confirmFreeFlow(page);
    if (confirmResult === 'login-required') {
      if (attempt === 2) {
        throw new Error('Login is still required after automatic login.');
      }

      console.log('Login required during confirmation. Trying automatic login...');
      await loginWithCredentials(page);
      continue;
    }

    await dismissCommonPopups(page);
    console.log(`Done: ${itemName}`);
    return;
  }
}

async function claimFrequency(page, frequency) {
  const label = frequency === 'daily' ? '1日1回' : '週1回';
  const marker = frequency === 'daily' ? /1日1回/ : /週1回/;
  let claimedAny = false;

  for (let index = 0; index < 5; index += 1) {
    await gotoShop(page);
    await dismissCommonPopups(page);

    if (await pageShowsLoginEntry(page)) {
      console.log('Login entry is visible before searching rewards. Trying automatic login...');
      await loginWithCredentials(page);
      await gotoShop(page);
      await dismissCommonPopups(page);
    }

    if (DRY_RUN) {
      const rewards = await findFrequencyRewards(page, marker);
      if (rewards.length === 0) {
        console.log(`No actionable ${label} free reward found.`);
        return;
      }

      for (const reward of rewards) {
        const actionText = normalize(await reward.action.innerText().catch(() => ''));
        console.log(`Detected ${label} reward: ${reward.name}`);
        console.log(`Action: ${actionText || '<icon/button>'}`);
      }
      console.log('DRY_RUN=true, skipping clicks.');
      return;
    }

    const found = await findFrequencyReward(page, marker);
    if (!found) {
      if (!claimedAny) {
        console.log(`No actionable ${label} free reward found.`);
        await logRewardCandidates(page, marker);
      }
      return;
    }

    console.log(`\n== Claiming detected ${label} reward: ${found.name} ==`);
    await claimDetectedReward(page, found.name, found.card, found.action, marker);
    claimedAny = true;
  }

  console.log(`Stopped after checking multiple ${label} rewards.`);
}

async function findFrequencyReward(page, marker) {
  const rewards = await findFrequencyRewards(page, marker);
  return rewards[0] ?? null;
}

async function findFrequencyRewards(page, marker) {
  const rewards = [];
  const buttons = page
    .locator('button:visible, [role="button"]:visible')
    .filter({ hasText: marker });
  const count = await buttons.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const action = buttons.nth(index);
    const actionText = normalize(await action.innerText().catch(() => ''));

    if (!/(獲得|受け取り|ガチャ|claim|free|マイレージ)/i.test(actionText)) continue;
    if (isCompletedText(actionText)) continue;

    const card = action.locator(
      'xpath=ancestor::*[self::li or self::article or self::section or self::div][.//button or @role="button" or .//a][1]',
    );
    const cardText = normalize(await card.innerText().catch(() => actionText));

    try {
      assertFreeClaimSurface(actionText, cardText);
    } catch (error) {
      console.log(`Skipping candidate that did not pass safety check: ${truncate(cardText, 200)}`);
      continue;
    }

    rewards.push({
      action,
      card,
      name: extractRewardName(cardText, actionText),
    });
  }

  return rewards;
}

async function logRewardCandidates(page, marker) {
  console.log('Reward candidate debug:');
  console.log(`URL: ${page.url()}`);
  console.log(`Title: ${await page.title().catch(() => '<unavailable>')}`);

  const buttonTexts = await page
    .locator('button:visible, [role="button"]:visible')
    .evaluateAll((buttons) => buttons.map((button) => button.innerText || button.textContent || '').filter(Boolean))
    .catch(() => []);

  const relatedButtons = buttonTexts
    .map(normalize)
    .filter((text) => marker.test(text) || /(獲得|受け取り|ガチャ|マイレージ|完了|無料|claim|free)/i.test(text))
    .slice(0, 30);

  if (relatedButtons.length > 0) {
    console.log('Related visible buttons:');
    for (const text of relatedButtons) {
      console.log(`- ${truncate(text, 240)}`);
    }
  } else {
    console.log('No related visible buttons found.');
  }

  const allButtons = buttonTexts.map(normalize).filter(Boolean).slice(0, 40);
  if (allButtons.length > 0) {
    console.log('All visible buttons:');
    for (const text of allButtons) {
      console.log(`- ${truncate(text, 180)}`);
    }
  }

  const bodyText = normalize(await page.locator('body').innerText().catch(() => ''));
  const relatedLines = bodyText
    .split(/(?=\[[^\]]+\])|(?=報酬)|(?=マイレージ)|(?=獲得)|(?=完了)/)
    .map(normalize)
    .filter((text) => marker.test(text) || /(獲得|受け取り|ガチャ|マイレージ|完了|無料|claim|free)/i.test(text))
    .slice(0, 20);

  if (relatedLines.length > 0) {
    console.log('Related page text:');
    for (const text of relatedLines) {
      console.log(`- ${truncate(text, 300)}`);
    }
  } else if (bodyText) {
    console.log(`Visible page text excerpt: ${truncate(bodyText, 1600)}`);
  }
}

function extractRewardName(cardText, fallback) {
  const normalized = normalize(cardText);
  const firstLine = normalized.split(/ 報酬| マイレージ| 獲得| 受け取り/)[0];
  return truncate(firstLine || fallback, 120);
}

async function claimDetectedReward(page, rewardName, card, action, marker) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const actionText = normalize(await action.innerText().catch(() => ''));
    console.log(`Action: ${actionText || '<icon/button>'}`);

    if (isCompletedText(actionText)) {
      console.log(`Already completed: ${rewardName}`);
      return;
    }

    if (DRY_RUN) {
      console.log('DRY_RUN=true, skipping click.');
      return;
    }

    await action.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await dismissCommonPopups(page);

    if (await pageShowsLoginRequired(page)) {
      if (attempt === 2) {
        throw new Error('Login is still required after automatic login.');
      }

      console.log('Login required. Trying automatic login...');
      await loginWithCredentials(page);
      await gotoShop(page);
      await dismissCommonPopups(page);

      const refreshed = await findFrequencyReward(page, marker);
      if (refreshed) {
        action = refreshed.action;
        card = refreshed.card;
      }
      continue;
    }

    const confirmResult = await confirmFreeFlow(page);
    if (confirmResult === 'login-required') {
      if (attempt === 2) {
        throw new Error('Login is still required after automatic login.');
      }

      console.log('Login required during confirmation. Trying automatic login...');
      await loginWithCredentials(page);
      await gotoShop(page);
      await dismissCommonPopups(page);

      const refreshed = await findFrequencyReward(page, marker);
      if (refreshed) {
        action = refreshed.action;
        card = refreshed.card;
      }
      continue;
    }

    await dismissCommonPopups(page);
    console.log(`Done: ${rewardName}`);
    return;
  }
}

function assertFreeClaimSurface(itemName, text) {
  // 有料商品を避けるため、無料または受け取り系の文言を保守的に確認します。
  const freeSignals = [
    '無料',
    '0円',
    '￥0',
    '¥0',
    'free',
    'claim',
    '受け取り',
    '獲得',
    'ガチャ',
  ];

  const paidPricePattern = /(?:￥|¥|\$|USD|JPY|円)\s*[1-9][0-9,.]*/i;
  if (paidPricePattern.test(text) && !/(無料|0円|￥0|¥0|free)/i.test(text)) {
    throw new Error(`Safety stop: "${itemName}" card contains a paid-looking price. Text: ${text}`);
  }

  if (!containsAny(text, freeSignals)) {
    throw new Error(`Safety stop: "${itemName}" does not look like a free claim. Text: ${text}`);
  }
}

async function findActionIn(root) {
  // 壊れやすい CSS クラスではなく、ボタンやリンクの表示名を優先して探します。
  const actionLabels = [
    /受け取り/,
    /獲得/,
    /無料/,
    /ガチャ/,
    /引く/,
    /受領/,
    /claim/i,
    /free/i,
  ];

  for (const label of actionLabels) {
    const button = root.getByRole('button', { name: label }).first();
    if (await button.isVisible().catch(() => false)) return button;

    const link = root.getByRole('link', { name: label }).first();
    if (await link.isVisible().catch(() => false)) return link;
  }

  return null;
}

async function confirmFreeFlow(page) {
  // 確認ダイアログが複数出る場合があるため、最前面のモーダルを優先して処理します。
  const steps = [
    /無料/,
    /受け取り/,
    /獲得/,
    /確認/,
    /^OK$/i,
    /閉じる/,
  ];

  for (let index = 0; index < 5; index += 1) {
    const modalText = await visibleModalText(page);
    if (/(ログイン後にご利用いただけます|ログインしてください|ログインが必要|please log in|sign in required)/i.test(modalText)) {
      return 'login-required';
    }

    const button = await firstVisibleModalButton(page, steps);
    if (button) {
      const buttonText = normalize(await button.innerText().catch(() => ''));
      if (isCompletedText(buttonText)) {
        console.log(`Completion button/state detected: ${buttonText}`);
        return 'done';
      }

      console.log(`Confirm: ${buttonText || '<icon/button>'}`);
      await button.click();
      await page.waitForTimeout(1500);
      continue;
    }

    const visibleText = normalize(await page.locator('body').innerText().catch(() => ''));
    if (isCompletedText(visibleText) || /(本日は|今週)/i.test(visibleText)) {
      console.log('Completion or already-claimed message detected.');
      return 'done';
    }

    return 'done';
  }

  return 'done';
}

async function pageShowsLoginRequired(page) {
  const modalText = await visibleModalText(page);
  const bodyText = normalize(await page.locator('body').innerText().catch(() => ''));
  return /(ログイン後にご利用いただけます|ログインしてください|ログインが必要|please log in|sign in required)/i.test(
    `${modalText} ${bodyText}`,
  );
}

async function pageShowsLoginEntry(page) {
  if (!hasLoginCredentials) return false;

  const loginButton = page
    .locator('button:visible, a:visible, [role="button"]:visible')
    .filter({ hasText: /ログイン|login|sign in/i })
    .first();

  return loginButton.isVisible().catch(() => false);
}

async function loginWithCredentials(page) {
  if (!hasLoginCredentials) {
    throw new Error('Login is required, but NETMARBLE_EMAIL and NETMARBLE_PASSWORD are not set.');
  }

  await closeLoginRequiredModal(page);
  await openLoginPage(page);
  await fillLoginForm(page);
  await waitForLoggedIn(page);
  fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
  await page.context().storageState({ path: STORAGE_STATE_PATH }).catch(() => {});
  console.log('Automatic login completed.');
}

async function closeLoginRequiredModal(page) {
  const topModal = page.locator('.modal.show.last, .modals .modal.show, [role="dialog"]').last();
  if (!(await topModal.isVisible().catch(() => false))) return;

  const closeButton = topModal
    .locator('button:visible, [role="button"]:visible')
    .filter({ hasText: /確認|OK|閉じる|close/i })
    .last();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
}

async function openLoginPage(page) {
  if (/signin|login|auth/i.test(page.url())) return;
  if (await openEmailLoginFromModal(page)) return;

  const loginControl = page
    .locator('button:visible, a:visible, [role="button"]:visible')
    .filter({ hasText: /ログイン|login|sign in/i })
    .first();

  if (!(await loginControl.isVisible().catch(() => false))) {
    throw new Error('Could not find the Netmarble login button.');
  }

  await loginControl.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2000);
  await openEmailLoginFromModal(page);
}

async function fillLoginForm(page) {
  const emailInput = page
    .locator(
      'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="メール"], input[placeholder*="mail" i], input[placeholder*="email" i]',
    )
    .first();
  const passwordInput = page
    .locator(
      'input[type="password"], input[name*="password" i], input[id*="password" i], input[placeholder*="パスワード"], input[placeholder*="password" i]',
    )
    .first();

  await emailInput.waitFor({ state: 'visible', timeout: 30_000 });
  await passwordInput.waitFor({ state: 'visible', timeout: 30_000 });

  console.log('Filling Netmarble e-mail login form...');
  await humanFill(emailInput, NETMARBLE_EMAIL);
  await humanFill(passwordInput, NETMARBLE_PASSWORD);

  const submitButton = page
    .locator('button:visible, [role="button"]:visible, input[type="submit"]:visible')
    .filter({ hasText: /ログイン|login|sign in|確認|次へ|続ける/i })
    .last();

  if (await submitButton.isVisible().catch(() => false)) {
    console.log('Submitting Netmarble login form...');
    await submitButton.click({ force: true });
  } else {
    console.log('Submitting Netmarble login form with Enter...');
    await passwordInput.press('Enter');
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(5000);

  if (await passwordInput.isVisible().catch(() => false)) {
    console.log('Login form still visible after click. Retrying with Enter...');
    await passwordInput.press('Enter');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(5000);
  }
}

async function humanFill(input, value) {
  await input.click();
  await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await input.press('Backspace');
  await input.type(value, { delay: 50 });
  await input.evaluate((element) => {
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function openEmailLoginFromModal(page) {
  const topModal = page.locator('.modal.show.last, .modals .modal.show, [role="dialog"]').last();
  if (!(await topModal.isVisible().catch(() => false))) return false;

  const emailSignIn = topModal
    .locator('button:visible, a:visible, [role="button"]:visible')
    .filter({ hasText: /e-?mail|メール|email/i })
    .last();

  if (!(await emailSignIn.isVisible().catch(() => false))) return false;

  const modalText = normalize(await topModal.innerText().catch(() => ''));
  if (!/(サインイン|sign in|ログイン|login)/i.test(modalText)) return false;

  console.log('Opening e-mail sign-in form...');
  await emailSignIn.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2000);
  return true;
}

async function waitForLoggedIn(page) {
  const deadline = Date.now() + 180_000;

  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);

    const cookies = await page.context().cookies().catch(() => []);
    if (cookies.some((cookie) => cookie.name === 'NMsololvShopToken')) return;

    if (page.url().startsWith(SHOP_URL) && !(await pageShowsLoginRequired(page))) return;

    const bodyText = normalize(await page.locator('body').innerText().catch(() => ''));
    if (/(認証|確認コード|captcha|CAPTCHA|メールを確認|verification|verify|incorrect|invalid|間違|エラー)/i.test(bodyText)) {
      throw new Error(`Automatic login needs attention: ${truncate(bodyText, 1000)}`);
    }
  }

  throw new Error('Automatic login did not complete. The site may require CAPTCHA, email verification, or another manual step.');
}

async function firstVisibleModalButton(page, labels) {
  const topModal = page.locator('.modal.show.last, .modals .modal.show, [role="dialog"]').last();
  const buttonRoots = (await topModal.isVisible().catch(() => false))
    ? [topModal, page]
    : [page];

  for (const label of labels) {
    for (const root of buttonRoots) {
      const candidates = root
        .locator('button:visible, [role="button"]:visible')
        .filter({ hasText: label });
      const count = await candidates.count().catch(() => 0);

      for (let index = count - 1; index >= 0; index -= 1) {
        const modalButton = candidates.nth(index);
        const className = await modalButton.getAttribute('class').catch(() => '');

        if (className?.includes('disabled')) {
          const buttonText = normalize(await modalButton.innerText().catch(() => ''));
          if (/(完了|獲得完了|受け取りました|獲得しました)/i.test(buttonText)) {
            return modalButton;
          }

          continue;
        }

        if (await modalButton.isVisible().catch(() => false)) {
          return modalButton;
        }
      }
    }
  }

  return null;
}

async function visibleModalText(page) {
  return normalize(await page.locator('.modal.show.last, .modals .modal.show, [role="dialog"]').last().innerText().catch(() => ''));
}

async function dismissCommonPopups(page) {
  // 商品カードや確認ボタンを隠す同意・通知ダイアログを閉じます。
  const labels = [/同意/, /許可/, /確認/, /^OK$/i, /閉じる/, /close/i, /accept/i];

  for (const label of labels) {
    const button = page.getByRole('button', { name: label }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

async function ensureLoggedIn(page) {
  // 保存済みセッションが切れている場合は、認証情報で自動ログインします。
  const bodyText = normalize(await page.locator('body').innerText().catch(() => ''));
  const url = page.url();
  const isLoginPage = /signin|login|auth/i.test(url);
  const asksForLogin = /(ログインしてください|ログインが必要|please log in|sign in required)/i.test(bodyText);

  if (isLoginPage || asksForLogin) {
    console.log('Login state appears to be expired. Trying automatic login...');
    await loginWithCredentials(page);
  }
}

async function logDebugState(page) {
  console.error('\nDebug state:');
  console.error(`URL: ${page.url()}`);
  console.error(`Title: ${await page.title().catch(() => '<unavailable>')}`);

  const modalText = normalize(
    await page.locator('.modals, .modal-window, [role="dialog"]').last().innerText().catch(() => ''),
  );
  if (modalText) {
    console.error(`Visible modal text: ${truncate(modalText, 1200)}`);
  }

  const buttonTexts = await page
    .locator('button:visible, [role="button"]:visible')
    .evaluateAll((buttons) => buttons.map((button) => button.innerText || button.textContent || '').filter(Boolean))
    .catch(() => []);

  if (buttonTexts.length > 0) {
    console.error('Visible buttons:');
    for (const text of buttonTexts.slice(0, 20)) {
      console.error(`- ${truncate(normalize(text), 200)}`);
    }
  }

  const bodyText = normalize(await page.locator('body').innerText().catch(() => ''));
  if (bodyText) {
    console.error(`Visible page text: ${truncate(bodyText, 1600)}`);
  }
}

function containsAny(text, needles) {
  const lower = text.toLowerCase();
  return needles.some((needle) => lower.includes(String(needle).toLowerCase()));
}

function isCompletedText(text) {
  return /(完了|獲得完了|受け取りました|獲得しました|already|すでに|claimed)/i.test(text);
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}
