// Two people in two browsers: a requester (Asha) and a matching donor nearby (Bilal). Each test
// sets up, through the API, only what comes before the step it is about, then checks that the
// other person's open page changes live, over the socket, without a reload (expectNoReload).
import { expect, expectNoReload, gotoLiveAndWatchForReloads, test } from './support/app.js';

const signUpRequesterAndDonor = async (app) => ({
  asha: await app.signUp({ name: 'Asha Requester', bloodGroup: 'B+' }),
  // A+ like every request below, so an exact match
  bilal: await app.signUp({ name: 'Bilal Donor', bloodGroup: 'A+' }),
});

const openMyRequests = async (page, hospitalName) => {
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'My Requests' }).click();
  await expect(page.getByRole('heading', { name: hospitalName, exact: true })).toBeVisible();
};

test('a new request reaches a matching donor live, without a reload', async ({ app }) => {
  const { asha, bilal } = await signUpRequesterAndDonor(app);
  const hospitalName = app.newHospitalName();

  await gotoLiveAndWatchForReloads(bilal.page, '/dashboard');
  await expect(bilal.page.getByText("You're all caught up!")).toBeVisible();

  await asha.page.goto('/create-request');
  await asha.page.getByRole('button', { name: /use my location/ }).click();
  await expect(asha.page.getByText('Hospital location set')).toBeVisible();
  await asha.page.getByLabel('Name shown to donors').fill(hospitalName);
  // The blood group select has no label of its own; it is the one whose placeholder is "Select"
  await asha.page
    .getByRole('combobox')
    .filter({ has: asha.page.getByRole('option', { name: 'Select', exact: true }) })
    .selectOption('A+');
  await asha.page.getByLabel('Urgency Level').selectOption('high');
  await asha.page.getByRole('button', { name: 'Broadcast Emergency Request' }).click();

  await expect(asha.page.getByRole('heading', { name: 'Request Broadcasted' })).toBeVisible();
  await expect(asha.page.getByText(`We've found 1 compatible donors near ${hospitalName}.`)).toBeVisible();

  await expect(bilal.page.getByRole('heading', { name: hospitalName, exact: true })).toBeVisible();
  await expect(bilal.page.getByText(`1 unit of A+ needed at ${hospitalName}.`)).toBeVisible();
  await expect(bilal.page.getByText('Exact Match')).toBeVisible();
  await expectNoReload(bilal.page);
});

test("the requester's dashboard updates live when the donor accepts", async ({ app }) => {
  const { asha, bilal } = await signUpRequesterAndDonor(app);
  const hospitalName = app.newHospitalName();
  await asha.createRequest({ hospitalName });

  await gotoLiveAndWatchForReloads(asha.page, '/dashboard');
  await asha.page.getByRole('button', { name: 'My Requests' }).click();
  await expect(asha.page.getByRole('heading', { name: hospitalName, exact: true })).toBeVisible();
  await expect(asha.page.getByText('PENDING', { exact: true })).toBeVisible();

  await bilal.page.goto('/dashboard');
  await expect(bilal.page.getByRole('heading', { name: hospitalName, exact: true })).toBeVisible();
  await bilal.page.getByRole('button', { name: 'Accept & Help' }).click();
  await expect(bilal.page.getByText('Accepted by you')).toBeVisible();

  await expect(asha.page.getByText('Bilal Donor accepted your request!')).toBeVisible();
  await expect(asha.page.getByText('ACCEPTED', { exact: true })).toBeVisible();
  await expect(asha.page.getByText('A donor has accepted this request! Open chat to coordinate.')).toBeVisible();
  await expect(asha.page.getByRole('button', { name: 'Mark as Fulfilled' })).toBeVisible();
  await expectNoReload(asha.page);
});

test('chat messages arrive live in both directions', async ({ app }) => {
  const { asha, bilal } = await signUpRequesterAndDonor(app);
  const hospitalName = app.newHospitalName();
  const { request } = await asha.createRequest({ hospitalName });
  await bilal.acceptRequest(request._id);

  await gotoLiveAndWatchForReloads(asha.page, '/dashboard');
  await asha.page.getByRole('button', { name: 'My Requests' }).click();
  await asha.page.getByRole('heading', { name: hospitalName, exact: true }).click();
  const ashaMessageBox = asha.page.getByPlaceholder('Type your message...');
  await expect(ashaMessageBox).toBeVisible();

  await gotoLiveAndWatchForReloads(bilal.page, '/dashboard');
  await bilal.page.getByRole('heading', { name: hospitalName, exact: true }).click();
  const bilalMessageBox = bilal.page.getByPlaceholder('Type your message...');
  await expect(bilalMessageBox).toBeVisible();

  await ashaMessageBox.fill('Ward 3, second floor. Are you on your way?');
  await ashaMessageBox.press('Enter');
  await expect(bilal.page.getByText('Ward 3, second floor. Are you on your way?')).toBeVisible();

  await bilalMessageBox.fill('Yes, about 20 minutes away');
  await bilalMessageBox.press('Enter');
  await expect(asha.page.getByText('Yes, about 20 minutes away')).toBeVisible();

  await expectNoReload(asha.page);
  await expectNoReload(bilal.page);
});

test('marking the request fulfilled shows the donor a live notice', async ({ app }) => {
  const { asha, bilal } = await signUpRequesterAndDonor(app);
  const hospitalName = app.newHospitalName();
  const { request } = await asha.createRequest({ hospitalName });
  await bilal.acceptRequest(request._id);

  await gotoLiveAndWatchForReloads(bilal.page, '/dashboard');
  await expect(bilal.page.getByText('Accepted by you')).toBeVisible();

  await openMyRequests(asha.page, hospitalName);
  await asha.page.getByRole('button', { name: 'Mark as Fulfilled' }).click();
  await expect(asha.page.getByText('Request marked as fulfilled!')).toBeVisible();

  await expect(bilal.page.getByText('Request has been marked as fulfilled! Thank you for donating.')).toBeVisible();
  await expect(bilal.page.getByRole('heading', { name: 'Donation Complete!' })).toBeVisible();
  await expect(bilal.page.getByText('Awaiting rating from requester')).toBeVisible();
  await expectNoReload(bilal.page);
});

test('the requester rates the donor, and the donor sees the rating live', async ({ app }) => {
  const { asha, bilal } = await signUpRequesterAndDonor(app);
  const hospitalName = app.newHospitalName();
  const { request } = await asha.createRequest({ hospitalName });
  await bilal.acceptRequest(request._id);
  await asha.fulfilRequest(request._id);

  await gotoLiveAndWatchForReloads(bilal.page, '/dashboard');
  await expect(bilal.page.getByText('Awaiting rating from requester')).toBeVisible();

  await openMyRequests(asha.page, hospitalName);
  await asha.page.getByRole('button', { name: 'Rate this Donor' }).click();
  await asha.page.getByRole('button', { name: 'Rate 5 stars' }).click();
  await asha.page.getByPlaceholder('Optional: leave a note for the donor...').fill('Thank you for coming so quickly');
  await asha.page.getByRole('button', { name: 'Submit Rating' }).click();
  await expect(asha.page.getByText('Rating submitted! Thank you.')).toBeVisible();
  await expect(asha.page.getByText('5/5', { exact: true })).toBeVisible();

  await expect(bilal.page.getByText('You received a 5★ rating!')).toBeVisible();
  await expect(bilal.page.getByText('Rated 5/5 by the requester')).toBeVisible();
  await expect(bilal.page.getByText('"Thank you for coming so quickly"', { exact: true })).toBeVisible();
  await expectNoReload(bilal.page);
});
