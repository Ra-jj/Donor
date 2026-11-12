import { expect, test } from './support/app.js';

test('a donor blocks a requester from the incoming list, and the request stays gone', async ({ app }) => {
  const asha = await app.signUp({ name: 'Asha Requester', bloodGroup: 'B+' });
  const bilal = await app.signUp({ name: 'Bilal Donor', bloodGroup: 'A+' });
  const hospitalName = app.newHospitalName();
  await asha.createRequest({ hospitalName });
  const { page } = bilal;

  await page.goto('/dashboard');
  const requestHeading = page.getByRole('heading', { name: hospitalName, exact: true });
  await expect(requestHeading).toBeVisible();

  await page.getByRole('button', { name: 'Report or block' }).click();
  await page.getByRole('dialog', { name: 'Report or block' }).getByRole('button', { name: /^Block this requester/ }).click();
  const confirmDialog = page.getByRole('dialog', { name: 'Block this requester?' });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: 'Block', exact: true }).click();

  await expect(page.getByText("Blocked. You won't be matched with each other again.")).toBeVisible();
  await expect(confirmDialog).toBeHidden();
  await expect(requestHeading).toBeHidden();

  // The server keeps the block: the request is not back after a reload
  await page.reload();
  await expect(page.getByText("You're all caught up!")).toBeVisible();
  await expect(requestHeading).toHaveCount(0);
});
