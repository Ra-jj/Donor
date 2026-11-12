import { expect, recordSocketTraffic, test, waitForServiceWorkerControl } from './support/app.js';

const HOME_HEADING = /Find blood donors/;
const OFFLINE_HEADING = "You're Offline";

test('the signed-out home page loads and opens no socket', async ({ app }) => {
  const { page } = await app.openVisitor();
  const socketTraffic = recordSocketTraffic(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: HOME_HEADING })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Sign up' })).toBeVisible();
  await waitForServiceWorkerControl(page);

  expect(socketTraffic.requests, 'socket.io requests from the signed-out home page').toEqual([]);
  expect(socketTraffic.webSockets, 'WebSockets from the signed-out home page').toEqual([]);
});

test('offline: the overlay shows, and / reloads from the service worker precache', async ({ app }) => {
  const { context, page } = await app.openVisitor();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: HOME_HEADING })).toBeVisible();
  await waitForServiceWorkerControl(page);

  await context.setOffline(true);
  await expect(page.getByRole('heading', { name: OFFLINE_HEADING })).toBeVisible();

  const offlineResponse = await page.reload();
  expect(offlineResponse?.fromServiceWorker(), 'the offline reload of / was answered by the service worker').toBe(true);
  await expect(page.getByRole('heading', { name: HOME_HEADING })).toBeVisible();
  await expect(page.getByRole('heading', { name: OFFLINE_HEADING })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByRole('heading', { name: OFFLINE_HEADING })).toBeHidden();
});
