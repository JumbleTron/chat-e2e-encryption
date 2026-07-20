import { chromium } from 'playwright-core';

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8081';
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const suffix = Date.now().toString(36);
const aliceName = `alice_${suffix}`;
const bobName = `bob_${suffix}`;
const roomName = `mls_${suffix}`;
const messageText = `MLS forward secrecy test ${suffix}`;

const browser = await chromium.launch({ executablePath, headless: true });
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
const linkedContext = await browser.newContext();
const alice = await aliceContext.newPage();
const bob = await bobContext.newPage();
const linked = await linkedContext.newPage();
const errors = [];

for (const [name, page] of [['alice', alice], ['bob', bob], ['linked', linked]]) {
  page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${name} console: ${message.text()}`);
  });
}

async function register(page, username) {
  await page.goto(origin);
  await page.getByPlaceholder('Nazwa użytkownika').fill(username);
  await page.getByPlaceholder('Nazwa urządzenia').fill(`${username} browser`);
  await page.getByRole('button', { name: 'Utwórz konto' }).click();
  await page.locator('.user-info strong').filter({ hasText: username }).waitFor({ timeout: 30_000 });
  await page.locator('.sidebar-footer .error').waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => {});
}

try {
  await register(alice, aliceName);
  await register(bob, bobName);

  await alice.getByRole('button', { name: /Nowy pokój/ }).click();
  await alice.getByPlaceholder('Nazwa pokoju').fill(roomName);
  await alice.getByRole('button', { name: 'Utwórz pokój', exact: true }).click();

  await alice.locator('.chat-header h2').filter({ hasText: roomName }).waitFor({ timeout: 30_000 });
  await alice.getByRole('button', { name: /Zaproś/ }).click();
  await alice.getByText(bobName, { exact: true }).click();
  await alice.locator('.modal button[type="submit"]').click();
  const bobRoom = bob.locator('.room-item').filter({ hasText: roomName });
  await bobRoom.waitFor({ timeout: 30_000 });
  await bobRoom.click();
  await bob.locator('.chat-header h2').filter({ hasText: roomName }).waitFor();

  await alice.getByPlaceholder('Napisz wiadomość (szyfrowana E2E)...').fill(messageText);
  await alice.getByRole('button', { name: 'Wyślij' }).click();
  await bob.locator('.message .bubble p').filter({ hasText: messageText }).waitFor({ timeout: 30_000 });

  await linked.goto(origin);
  await linked.getByRole('button', { name: 'Połącz urządzenie' }).click();
  await linked.getByPlaceholder('Nazwa użytkownika').fill(aliceName);
  await linked.getByPlaceholder('Nazwa urządzenia').fill('Alice linked browser');
  await linked.getByRole('button', { name: 'Wygeneruj kod' }).click();
  const verificationCode = (await linked.locator('.link-code-panel strong').innerText()).trim();

  await alice.getByRole('button', { name: 'Urządzenia' }).click();
  const pendingRow = alice.locator('.device-row.pending').filter({ hasText: verificationCode });
  await pendingRow.waitFor({ timeout: 15_000 });
  await pendingRow.getByRole('button', { name: 'Zatwierdź' }).click();
  await alice.getByRole('button', { name: 'Zamknij' }).click();

  await linked.locator('.user-info strong').filter({ hasText: aliceName }).waitFor({ timeout: 30_000 });
  const linkedRoom = linked.locator('.room-item').filter({ hasText: roomName });
  await linkedRoom.waitFor({ timeout: 30_000 });
  await linkedRoom.click();

  const linkedMessage = `MLS linked device ${suffix}`;
  await alice.getByPlaceholder('Napisz wiadomość (szyfrowana E2E)...').fill(linkedMessage);
  await alice.getByRole('button', { name: 'Wyślij' }).click();
  await linked.locator('.message .bubble p').filter({ hasText: linkedMessage }).waitFor({ timeout: 30_000 });

  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  console.log('MLS browser test passed: group messaging and linked-device Welcome flow completed.');
} catch (error) {
  console.error(error);
  console.error(`Captured browser errors:\n${errors.join('\n') || '(none)'}`);
  console.error(`Alice page:\n${(await alice.locator('body').innerText()).slice(0, 4000)}`);
  console.error(`Linked page:\n${(await linked.locator('body').innerText()).slice(0, 4000)}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
