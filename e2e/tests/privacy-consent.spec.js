import { expect, recordSocketTraffic, test, waitForLiveConnection, waitForServiceWorkerControl } from './support/app.js';
import { makePrivacyConsentOutOfDate } from './support/database.js';

test('a user who must agree to a newer Privacy Notice gets no socket until Continue', async ({ app }) => {
  const olga = await app.signUp({ name: 'Olga Oldnotice', bloodGroup: 'O+' });
  await makePrivacyConsentOutOfDate(olga.id);
  const { page } = olga;
  const socketTraffic = recordSocketTraffic(page);

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'The Privacy Notice has changed' })).toBeVisible();
  // The consent screen stands in for the page asked for, at its own URL
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Welcome, Olga Oldnotice' })).toHaveCount(0);
  await waitForServiceWorkerControl(page);
  expect(socketTraffic.requests, 'socket.io requests while the consent screen is up').toEqual([]);
  expect(socketTraffic.webSockets, 'WebSockets while the consent screen is up').toEqual([]);

  const connected = waitForLiveConnection(page);
  await page.getByLabel('I agree to Donor using my data as described in the Privacy Notice').check();
  await page.getByLabel('I am 18 or older').check();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Welcome, Olga Oldnotice' })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  await connected;
});
