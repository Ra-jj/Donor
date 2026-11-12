import { PASSWORD, expect, test } from './support/app.js';

test('a new user signs up with the privacy consent, logs out and logs back in', async ({ app }) => {
  const { page } = await app.openVisitor();
  const email = app.newEmail('nina');

  await page.goto('/register');
  await page.getByPlaceholder('John Doe').fill('Nina Newcomer');
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('combobox').selectOption('A+');
  // The browser's position, which this test's context sets to its own area
  await page.getByRole('button', { name: 'Click to Get Current Location' }).click();
  await expect(page.getByRole('button', { name: /Location Captured/ })).toBeVisible();

  // Both agreements are required: without them the form stays put and says why
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Tick this box to agree to the Privacy Notice.' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Tick this box to confirm you are 18 or older.' })).toBeVisible();
  await expect(page).toHaveURL(/\/register$/);

  await page.getByLabel('I agree to Donor using my data as described in the Privacy Notice').check();
  await page.getByLabel('I am 18 or older').check();
  await page.getByRole('button', { name: 'Create Account' }).click();

  // Each confirmation is checked first, right after its click: it shows for about two seconds
  await expect(page.getByText('Account created successfully')).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Welcome, Nina Newcomer' })).toBeVisible();

  // Log out from the account menu, opened from the initial in the navigation bar
  await page.getByRole('navigation').getByText('N', { exact: true }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByText('Logged out successfully')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

  // The session really ended on the server: the dashboard now sends this browser to the login page
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log In' }).click();

  await expect(page.getByText('Logged in successfully')).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Welcome, Nina Newcomer' })).toBeVisible();
});
