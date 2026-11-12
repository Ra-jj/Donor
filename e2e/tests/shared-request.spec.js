import { expect, test } from './support/app.js';

test('a shared request link shows the request to a signed-out visitor', async ({ app }) => {
  const asha = await app.signUp({ name: 'Asha Requester', bloodGroup: 'B+' });
  const hospitalName = app.newHospitalName();
  const { shareToken } = await asha.createRequest({ hospitalName, bloodGroup: 'O-', unitsNeeded: 2 });

  const { page } = await app.openVisitor();
  const response = await page.goto(`/r/${shareToken}`);
  // Kept out of search results, like the API answer the page is built from
  expect(response?.headers()['x-robots-tag']).toBe('noindex');

  await expect(page.getByRole('heading', { name: 'O- Blood needed' })).toBeVisible();
  await expect(page.getByText(hospitalName)).toBeVisible();
  await expect(page.getByText('2 units', { exact: true })).toBeVisible();
  // The visitor's version of the page: sign up or log in, where an account holder gets "Open dashboard"
  await expect(page.getByRole('link', { name: 'Sign up to donate' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open dashboard' })).toHaveCount(0);
});
