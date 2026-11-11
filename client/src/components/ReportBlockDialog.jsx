import { useEffect, useId, useRef, useState } from 'react';
import { motion } from 'motion/react';
import toast from 'react-hot-toast';
import { ArrowLeftIcon, FlagIcon, ProhibitIcon, UserMinusIcon } from '@phosphor-icons/react';
import { axiosInstance } from '../lib/axios';

// Reasons and note limit, as the server checks them (server/validators/reportValidator.js)
const REPORT_REASONS = [
  { value: 'fake', label: 'Fake or misleading' },
  { value: 'abusive', label: 'Abusive or threatening' },
  { value: 'spam', label: 'Spam or advertising' },
  { value: 'other', label: 'Something else' },
];
const MAX_NOTE_LENGTH = 300;

// The other person on the request, as the caller knows them. Never a name: a donor's incoming list
// may not show one, and the requester's list holds only the donor's id.
const otherPartyOf = (role) => (role === 'requester' ? 'donor' : 'requester');

// The server's own words for a refusal (a 429, a request that changed), the first field error for a
// rejected body, or a plain fallback that claims no cause
const describeError = (error, fallback) => {
  const fieldErrors = error.response?.data?.errors;
  const firstFieldError = fieldErrors && Object.values(fieldErrors)[0];
  return firstFieldError || error.response?.data?.message || fallback;
};

/**
 * Report a request, report the other person on it, or block them, from one request.
 * role is the caller's place on that request:
 * - 'viewer': a donor seeing it in their incoming list. Report it, or block its requester.
 * - 'donor': its matched donor, from the chat. Report it, report the requester, or block them.
 * - 'requester': from the chat. Report the matched donor, or block them.
 * Rendered only while open, as a native <dialog> opened with showModal() like DeleteAccountDialog:
 * focus stays inside, the page behind is inert, and Esc closes it. onChanged runs after anything
 * that changed the request lists (a report, a block, or a refusal that means a list is out of date).
 */
const ReportBlockDialog = ({ requestId, role, onClose, onChanged }) => {
  const dialogRef = useRef(null);
  const headingRef = useRef(null);
  const firstChoiceRef = useRef(null);
  const firstReasonRef = useRef(null);
  const idPrefix = useId();
  const titleId = `${idPrefix}-title`;
  const reasonsLabelId = `${idPrefix}-reasons`;
  const noteId = `${idPrefix}-note`;
  const noteCountId = `${idPrefix}-note-count`;
  const errorId = `${idPrefix}-error`;
  const alsoBlockId = `${idPrefix}-also-block`;
  const alsoBlockHelpId = `${idPrefix}-also-block-help`;

  // 'choose', then one of 'reportRequest', 'reportUser' or 'block'
  const [view, setView] = useState('choose');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const otherParty = otherPartyOf(role);
  const isMatched = role !== 'viewer';

  useEffect(() => {
    const dialog = dialogRef.current;
    // As in DeleteAccountDialog: StrictMode runs this twice in development, and a second
    // showModal() on an open dialog throws in older browsers. showModal() would focus the heading
    // (focusable for the views after this one), so the first action takes focus instead.
    if (!dialog.open) dialog.showModal();
    firstChoiceRef.current?.focus();
  }, []);

  // Each new view takes focus to its heading, so a screen reader announces where the user now is.
  // Compared with the view last focused, not run-once logic, so StrictMode's second run of effects
  // in development leaves focus on the first action as well.
  const focusedView = useRef(view);
  useEffect(() => {
    if (focusedView.current === view) return;
    focusedView.current = view;
    headingRef.current?.focus();
  }, [view]);

  const openView = (nextView) => {
    setErrorMessage('');
    setView(nextView);
  };

  const closeDialog = () => dialogRef.current?.close();

  // One request at a time; the dialog stays open on a refusal, with the reason shown in it
  const send = async (call, describeSuccess) => {
    setErrorMessage('');
    setIsSending(true);
    try {
      const res = await call();
      toast.success(describeSuccess(res), { duration: 6000 });
      onChanged();
      closeDialog();
    } catch (error) {
      setIsSending(false);
      setErrorMessage(describeError(error, "Couldn't send that. Please try again."));
      // The request is gone, or changed since the list loaded: reload it behind the dialog
      if ([403, 404, 409].includes(error.response?.status)) onChanged();
    }
  };

  const handleReport = (event) => {
    event.preventDefault();
    if (!reason) {
      setErrorMessage('Choose a reason.');
      firstReasonRef.current?.focus();
      return;
    }
    if (view === 'reportRequest') {
      send(
        () => axiosInstance.post(`/requests/${requestId}/report`, { reason, note }),
        // A donor who reported it from their incoming list no longer sees it
        (res) => `${res.data.message}${role === 'viewer' ? " You won't see this request again." : ''}`
      );
    } else {
      send(
        () => axiosInstance.post(`/requests/${requestId}/report-user`, { reason, note, alsoBlock }),
        (res) => res.data.message
      );
    }
  };

  const handleBlock = () =>
    send(
      () => axiosInstance.post(`/requests/${requestId}/block`),
      () => "Blocked. You won't be matched with each other again."
    );

  const heading = (text) => (
    <h2 ref={headingRef} id={titleId} tabIndex={-1} className="text-xl font-display font-bold focus:outline-none">
      {text}
    </h2>
  );

  const backButton = (
    <button type="button" onClick={() => openView('choose')} disabled={isSending} className="btn btn-ghost rounded-xl">
      <ArrowLeftIcon weight="bold" className="w-4 h-4" aria-hidden="true" />
      Back
    </button>
  );

  const errorLine = errorMessage && (
    <p id={errorId} role="alert" className="text-sm font-medium text-error">
      {errorMessage}
    </p>
  );

  const choices = [
    role !== 'requester' && {
      view: 'reportRequest',
      Icon: FlagIcon,
      label: 'Report this request',
      detail: role === 'viewer' ? "Fake, abusive or spam. You won't see it again." : 'Fake, abusive or spam.',
    },
    isMatched && {
      view: 'reportUser',
      Icon: UserMinusIcon,
      label: `Report the ${otherParty}`,
      detail: 'For how they behaved. You can block them too.',
    },
    {
      view: 'block',
      Icon: ProhibitIcon,
      label: role === 'viewer' ? 'Block this requester' : `Block the ${otherParty}`,
      detail: "You won't be matched with each other again.",
    },
  ].filter(Boolean);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      // Esc must not hide the dialog while a request is on its way: its answer lands here
      onCancel={(event) => {
        if (isSending) event.preventDefault();
      }}
      // A click on the dimmed area outside the panel reaches the <dialog> itself
      onClick={(event) => {
        if (event.target === event.currentTarget && !isSending) closeDialog();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border border-base-300 bg-base-100 text-base-content shadow-2xl backdrop:bg-[rgb(0_0_0/0.55)]"
    >
      <motion.div
        key={view}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="p-6 sm:p-8"
      >
        {view === 'choose' && (
          <div className="space-y-5">
            <div className="space-y-2">
              {heading('Report or block')}
              <p className="text-sm text-base-content/70 leading-relaxed">
                Only the person who runs Donor sees reports. Nobody is told who reported or blocked them.
              </p>
            </div>
            <ul className="space-y-2">
              {choices.map(({ view: choiceView, Icon, label, detail }, index) => (
                <li key={choiceView}>
                  <button
                    ref={index === 0 ? firstChoiceRef : undefined}
                    type="button"
                    onClick={() => openView(choiceView)}
                    className="w-full flex items-start gap-3 rounded-2xl border border-base-300 p-4 text-left hover:bg-base-200 active:bg-base-200 transition-colors"
                  >
                    <Icon
                      weight="duotone"
                      className={`w-6 h-6 shrink-0 ${choiceView === 'block' ? 'text-error' : 'text-primary'}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span className="block font-semibold">{label}</span>
                      <span className="block text-sm text-base-content/70">{detail}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <button type="button" onClick={closeDialog} className="btn btn-ghost rounded-xl">
                Cancel
              </button>
            </div>
          </div>
        )}

        {(view === 'reportRequest' || view === 'reportUser') && (
          <form onSubmit={handleReport} noValidate className="space-y-5">
            <div className="space-y-2">
              {heading(view === 'reportRequest' ? 'Report this request' : `Report the ${otherParty}`)}
              <p className="text-sm text-base-content/70 leading-relaxed">
                {view === 'reportRequest'
                  ? 'Only the person who runs Donor sees your report. The requester is never told who reported it. If 3 people who joined Donor before it was posted report it, it is closed.'
                  : `Only the person who runs Donor sees your report. The ${otherParty} is never told about it.`}
              </p>
            </div>

            <div
              role="radiogroup"
              aria-labelledby={reasonsLabelId}
              aria-describedby={errorMessage && !reason ? errorId : undefined}
              className="space-y-2"
            >
              <p id={reasonsLabelId} className="text-sm font-semibold text-base-content/70">
                Why are you reporting {view === 'reportRequest' ? 'it' : 'them'}?
              </p>
              {REPORT_REASONS.map(({ value, label }, index) => (
                <label
                  key={value}
                  className="flex items-center gap-3 rounded-xl border border-base-300 px-4 py-3 cursor-pointer has-checked:border-primary has-checked:bg-primary/5"
                >
                  <input
                    ref={index === 0 ? firstReasonRef : undefined}
                    type="radio"
                    name={`${idPrefix}-reason`}
                    value={value}
                    checked={reason === value}
                    onChange={() => setReason(value)}
                    className="radio radio-primary radio-sm shrink-0"
                  />
                  <span className="text-sm font-medium">{label}</span>
                </label>
              ))}
            </div>

            <div className="space-y-2">
              <label htmlFor={noteId} className="text-sm font-semibold text-base-content/70 block">
                Anything else? (optional)
              </label>
              <textarea
                id={noteId}
                rows={3}
                maxLength={MAX_NOTE_LENGTH}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                aria-describedby={noteCountId}
                className="textarea w-full rounded-xl bg-base-100 text-base"
              />
              <p id={noteCountId} className="text-xs text-base-content/60 text-right">
                {note.length}/{MAX_NOTE_LENGTH}
              </p>
            </div>

            {view === 'reportUser' && (
              <div>
                <label htmlFor={alsoBlockId} className="flex items-start gap-3 cursor-pointer text-sm font-medium leading-snug">
                  <input
                    id={alsoBlockId}
                    type="checkbox"
                    checked={alsoBlock}
                    onChange={(event) => setAlsoBlock(event.target.checked)}
                    aria-describedby={alsoBlockHelpId}
                    className="checkbox checkbox-primary shrink-0"
                  />
                  <span className="pt-0.5">Also block the {otherParty}</span>
                </label>
                <p id={alsoBlockHelpId} className="text-xs text-base-content/60 leading-relaxed mt-1.5 ml-9">
                  Your match with them ends, and you won't be matched with each other again. They aren't told.
                </p>
              </div>
            )}

            {errorLine}

            {/* Side by side from 360 px; narrower, one full-width row each, so neither wraps alone */}
            <div className="flex flex-col gap-2 min-[360px]:flex-row min-[360px]:justify-end">
              {backButton}
              <button type="submit" disabled={isSending} className="btn btn-primary text-primary-content rounded-xl font-bold">
                {isSending ? (
                  <span className="loading loading-spinner loading-sm" aria-hidden="true"></span>
                ) : (
                  <FlagIcon weight="bold" className="w-5 h-5" aria-hidden="true" />
                )}
                {isSending ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </form>
        )}

        {view === 'block' && (
          <div className="space-y-5">
            {heading(role === 'viewer' ? 'Block this requester?' : `Block the ${otherParty}?`)}
            <div className="space-y-3 text-sm text-base-content/80 leading-relaxed">
              <p>
                You won't be matched with each other again: neither of you gets the other's requests or alerts, and
                neither can accept the other's requests.
              </p>
              {isMatched && (
                <p className="font-semibold text-base-content">Your current match with them ends, and so does this chat.</p>
              )}
              <p>They aren't told. You can unblock them in Profile.</p>
            </div>

            {errorLine}

            {/* Side by side from 360 px; narrower, one full-width row each, so neither wraps alone */}
            <div className="flex flex-col gap-2 min-[360px]:flex-row min-[360px]:justify-end">
              {backButton}
              <button type="button" onClick={handleBlock} disabled={isSending} className="btn btn-error text-base-100 rounded-xl font-bold">
                {isSending ? (
                  <span className="loading loading-spinner loading-sm" aria-hidden="true"></span>
                ) : (
                  <ProhibitIcon weight="bold" className="w-5 h-5" aria-hidden="true" />
                )}
                {isSending ? 'Blocking…' : 'Block'}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </dialog>
  );
};

export default ReportBlockDialog;
