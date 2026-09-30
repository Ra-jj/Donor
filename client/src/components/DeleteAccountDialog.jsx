import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { TrashIcon, WarningOctagonIcon } from '@phosphor-icons/react';
import { useAuthStore } from '../store/useAuthStore';

// Rendered only while open. A native <dialog> opened with showModal(): the browser keeps focus
// inside it, makes the page behind inert, and fires "cancel" on Esc. The app has no other
// overlay that does all three.
const DeleteAccountDialog = ({ onClose }) => {
  const { deleteAccount } = useAuthStore();
  const navigate = useNavigate();
  const dialogRef = useRef(null);
  const passwordInputRef = useRef(null);
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    // StrictMode runs this twice on the same element in development, and a second showModal() on
    // an open dialog throws in older browsers. It focuses the first field, the password. Unmounting
    // takes the element out of the page, and the dialog with it.
    if (!dialog.open) dialog.showModal();
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setErrorMessage('');
    setIsDeleting(true);
    const result = await deleteAccount(password);
    if (result.success) {
      // Already signed out by the store; go where logging out leads
      dialogRef.current?.close();
      navigate('/login', { replace: true });
      return;
    }
    setIsDeleting(false);
    setErrorMessage(result.message);
    setPassword('');
    passwordInputRef.current?.focus();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="delete-account-title"
      aria-describedby="delete-account-summary"
      onClose={onClose}
      // Esc must not hide the dialog while the deletion is on its way: its answer lands here
      onCancel={(event) => {
        if (isDeleting) event.preventDefault();
      }}
      // A click on the dimmed area outside the panel reaches the <dialog> itself
      onClick={(event) => {
        if (event.target === event.currentTarget && !isDeleting) dialogRef.current.close();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border border-base-300 bg-base-100 text-base-content shadow-2xl backdrop:bg-[rgb(0_0_0/0.55)]"
    >
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="p-6 sm:p-8"
      >
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="flex items-center gap-3">
            <WarningOctagonIcon weight="duotone" className="w-8 h-8 text-error shrink-0" />
            <h2 id="delete-account-title" className="text-xl font-display font-bold">
              Delete your account?
            </h2>
          </div>

          <div id="delete-account-summary" className="space-y-3 text-sm text-base-content/80 leading-relaxed">
            <p className="font-semibold text-base-content">This can't be undone.</p>
            <p>
              Your profile, email, location, push notifications and chat messages are erased, along with every request
              of yours that wasn't fulfilled.
            </p>
            <p>
              Completed donations stay in the other person's history, shown as "Deleted user". If you accepted a
              request as a donor, it goes back to the requester as open.
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="delete-account-password" className="text-sm font-semibold text-base-content/70 block">
              Your current password
            </label>
            <input
              ref={passwordInputRef}
              id="delete-account-password"
              type="password"
              autoComplete="current-password"
              required
              className="input w-full rounded-xl bg-base-100 text-base"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={errorMessage ? 'true' : undefined}
              aria-describedby={errorMessage ? 'delete-account-error' : undefined}
            />
            {errorMessage && (
              <p id="delete-account-error" role="alert" className="text-sm font-medium text-error">
                {errorMessage}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => dialogRef.current.close()}
              disabled={isDeleting}
              className="btn btn-ghost rounded-xl"
            >
              Cancel
            </button>
            <button type="submit" disabled={isDeleting} className="btn btn-error text-base-100 rounded-xl font-bold">
              {isDeleting ? (
                <span className="loading loading-spinner loading-sm" aria-hidden="true"></span>
              ) : (
                <TrashIcon weight="bold" className="w-5 h-5" />
              )}
              {isDeleting ? 'Deleting…' : 'Delete account'}
            </button>
          </div>
        </form>
      </motion.div>
    </dialog>
  );
};

export default DeleteAccountDialog;
