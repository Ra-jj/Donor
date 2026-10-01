import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DropIcon, SignOutIcon, TrashIcon } from '@phosphor-icons/react';
import { useAuthStore } from '../store/useAuthStore';
import PrivacySummary from '../components/PrivacySummary';
import PrivacyConsentFields from '../components/PrivacyConsentFields';
import DeleteAccountDialog from '../components/DeleteAccountDialog';
import { findMissingConsentErrors } from '../lib/privacyConsent';

const ID_PREFIX = 'consent';

// Shown by App in place of every page but /privacy while the signed-in user has not agreed to the
// current Privacy Notice (authUser.needsPrivacyConsent, decided by the server). It is not a route:
// the URL stays the page that was asked for, and agreeing shows that page, with no reload.
// Deleting the account instead uses the same password dialog as Profile, opened here, so no app
// page runs before the user has agreed.
const PrivacyConsentPage = () => {
  const { authUser, acceptPrivacyNotice, logout } = useAuthStore();
  const navigate = useNavigate();
  const [values, setValues] = useState({ acceptPrivacy: false, confirmAdult: false });
  const [errors, setErrors] = useState({});
  const [saveError, setSaveError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  // Agreed to an older version before, rather than never
  const isNewVersion = Boolean(authUser?.privacyConsent);

  const handleConsentChange = (name, checked) => {
    setValues((prev) => ({ ...prev, [name]: checked }));
    if (checked) setErrors((prev) => ({ ...prev, [name]: '' }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaveError('');
    const missingConsentErrors = findMissingConsentErrors(values);
    const firstMissing = Object.keys(missingConsentErrors)[0];
    if (firstMissing) {
      setErrors(missingConsentErrors);
      document.getElementById(`${ID_PREFIX}-${firstMissing}`)?.focus();
      return;
    }

    setIsSaving(true);
    const result = await acceptPrivacyNotice(values);
    // On success the store's new authUser replaces this screen with the page that was asked for
    if (result.success) return;
    // The session had ended, so the store signed out and this screen is already gone. /login shows
    // why; the URL's own page might not (on '/' a signed-out user gets the home page).
    if (result.signedOut) {
      navigate('/login', { replace: true });
      return;
    }
    setIsSaving(false);
    if (result.errors) setErrors(result.errors);
    if (result.message) setSaveError(result.message);
  };

  return (
    <div className="min-h-screen flex justify-center px-4 py-8 sm:py-14">
      <div className="w-full max-w-lg">
        <div className="flex items-center gap-2 mb-6">
          <DropIcon weight="duotone" className="w-8 h-8 text-primary" aria-hidden="true" />
          <span className="text-2xl font-display font-extrabold text-base-content tracking-tight">Donor</span>
        </div>

        <div className="bg-base-100 border border-base-300 rounded-3xl shadow-sm p-5 sm:p-8">
          <h1 className="text-2xl sm:text-3xl font-display font-extrabold text-base-content tracking-tight">
            {isNewVersion ? 'The Privacy Notice has changed' : 'Before you continue'}
          </h1>
          <p className="mt-2 text-base-content/70 leading-relaxed">
            {isNewVersion
              ? 'Please read the summary and agree to the new version to keep using your account.'
              : 'Donor now has a Privacy Notice that explains what it stores about you and why. Please read the summary and agree to keep using your account.'}
          </p>
          {authUser?.email && (
            <p className="mt-2 text-sm text-base-content/60 wrap-anywhere">Signed in as {authUser.email}</p>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            <PrivacySummary headingLevel={2} />
            <PrivacyConsentFields idPrefix={ID_PREFIX} values={values} errors={errors} onChange={handleConsentChange} />
            {saveError && (
              <p role="alert" className="text-error text-sm font-medium">
                {saveError}
              </p>
            )}
            <button
              type="submit"
              disabled={isSaving}
              className="btn btn-primary w-full rounded-xl text-white font-bold h-12 text-base"
            >
              {isSaving ? <span className="loading loading-spinner" aria-hidden="true"></span> : 'Continue'}
              {isSaving && <span className="sr-only">Saving</span>}
            </button>
          </form>

          <div className="mt-6 pt-4 border-t border-base-300 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setIsDeleteDialogOpen(true)}
              disabled={isSaving}
              className="btn btn-ghost rounded-xl text-error font-semibold px-3 min-h-11"
            >
              <TrashIcon weight="bold" className="w-5 h-5" aria-hidden="true" />
              Delete my account instead
            </button>
            <button
              type="button"
              onClick={logout}
              disabled={isSaving}
              className="btn btn-ghost rounded-xl font-semibold px-3 min-h-11"
            >
              <SignOutIcon weight="regular" className="w-5 h-5" aria-hidden="true" />
              Log out
            </button>
          </div>
        </div>
      </div>

      {isDeleteDialogOpen && <DeleteAccountDialog onClose={() => setIsDeleteDialogOpen(false)} />}
    </div>
  );
};

export default PrivacyConsentPage;
