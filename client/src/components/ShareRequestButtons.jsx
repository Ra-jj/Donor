import { useEffect, useId, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { WhatsappLogoIcon, ShareNetworkIcon, CopyIcon } from '@phosphor-icons/react';
import { axiosInstance } from '../lib/axios';
import { buildRequestPageUrl, buildRequestShareText, buildWhatsAppShareUrl } from '../lib/shareRequest';
import { cacheShareToken, getCachedShareToken } from '../lib/shareTokenCache';

/**
 * Lets a requester pass their own open request on to people who are not on Donor. WhatsApp
 * always, as that is where blood requests spread in India. Next to it, the device's share sheet
 * where the browser has one (phones, mostly); otherwise copying the text, to paste anywhere.
 *
 * The shared link opens the request's own page. Its token comes with the create response (the
 * success screen passes it in as shareToken) or, for a request on the dashboard, from
 * POST /requests/:id/share-link when the buttons mount. Until it arrives the buttons wait; if it
 * can't be had, the link is the app's home page.
 *
 * @param {{ request: { _id: string, bloodGroup: string, unitsNeeded: number, hospitalName: string, urgency: string }, shareToken?: string }} props
 */
const ShareRequestButtons = ({ request, shareToken: givenShareToken }) => {
  const noteId = useId();
  const requestId = String(request._id);
  const knownShareToken = givenShareToken || getCachedShareToken(requestId);
  const [fetchedLink, setFetchedLink] = useState({ requestId: null, shareToken: null, hasSettled: false });
  const [isSharing, setIsSharing] = useState(false);
  // Read synchronously, so a second press before the re-render is refused too
  const isSharingRef = useRef(false);

  useEffect(() => {
    if (givenShareToken) cacheShareToken(requestId, givenShareToken);
  }, [givenShareToken, requestId]);

  useEffect(() => {
    if (knownShareToken) return undefined;
    let isCancelled = false;
    axiosInstance.post(`/requests/${requestId}/share-link`)
      .then((res) => {
        const { shareToken } = res.data;
        if (typeof shareToken !== 'string' || !shareToken) throw new Error('share-link response has no shareToken');
        cacheShareToken(requestId, shareToken);
        if (!isCancelled) setFetchedLink({ requestId, shareToken, hasSettled: true });
      })
      .catch((error) => {
        // The home page link still works, so the requester can share anyway
        console.warn(`Could not get the share link of request ${requestId}; sharing the app's address instead:`, error);
        if (!isCancelled) setFetchedLink({ requestId, shareToken: null, hasSettled: true });
      });
    return () => {
      isCancelled = true;
    };
  }, [knownShareToken, requestId]);

  // An answer kept for another request (the same buttons given a new request) does not count
  const fetchedForThisRequest = fetchedLink.requestId === requestId ? fetchedLink : null;
  const shareToken = knownShareToken || fetchedForThisRequest?.shareToken || null;
  const isLinkLoading = !shareToken && !fetchedForThisRequest?.hasSettled;
  const origin = window.location.origin;
  const shareText = buildRequestShareText(request, {
    requestPageUrl: shareToken ? buildRequestPageUrl(origin, shareToken) : null,
    appUrl: `${origin}/`,
  });
  const hasShareSheet = typeof navigator.share === 'function';
  const canCopyText = !hasShareSheet && typeof navigator.clipboard?.writeText === 'function';

  const openShareSheet = async () => {
    // A second share() while the sheet is still open is refused, so it waits for this one
    if (isLinkLoading || isSharingRef.current) return;
    isSharingRef.current = true;
    setIsSharing(true);
    try {
      await navigator.share({ text: shareText });
    } catch (error) {
      // AbortError: the requester closed the sheet without choosing an app, which is fine
      if (error?.name !== 'AbortError') {
        console.error('navigator.share failed:', error);
        toast.error("Sharing didn't work. Use Share on WhatsApp instead.");
      }
    } finally {
      isSharingRef.current = false;
      setIsSharing(false);
    }
  };

  const copyShareText = async () => {
    if (isLinkLoading) return;
    try {
      await navigator.clipboard.writeText(shareText);
      toast.success('Message copied');
    } catch (error) {
      console.error('Copying the share text failed:', error);
      toast.error("Couldn't copy the message. Use Share on WhatsApp instead.");
    }
  };

  // aria-disabled stops a pointer (daisyUI turns pointer events off), but Enter on a focused link
  // still follows it, so the link checks too
  const holdWhileLinkLoads = (event) => {
    if (isLinkLoading) event.preventDefault();
  };
  // The green fill and dark text are utilities, which win over daisyUI's aria-disabled look, so
  // while the link loads they are left off and the button fades like the ones beside it
  const whatsAppToneClassName = isLinkLoading
    ? 'bg-base-100 border-base-300'
    : 'text-base-content bg-success/10 border-success/20 hover:bg-success/20';

  return (
    <div aria-busy={isLinkLoading || undefined}>
      {/* Side by side only when every label fits on one line, otherwise one control per row (phones):
          min-w-fit keeps a control from narrowing below its one-line width. A label too long even for
          a whole row (large text on a narrow phone) wraps instead, and h-auto lets its control get taller */}
      <div className="flex flex-wrap gap-2">
        <a
          href={buildWhatsAppShareUrl(shareText)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={holdWhileLinkLoads}
          aria-disabled={isLinkLoading || undefined}
          aria-describedby={noteId}
          className={`btn flex-1 min-w-fit min-h-11 h-auto py-2 leading-tight rounded-xl font-bold ${whatsAppToneClassName}`}
        >
          <WhatsappLogoIcon weight="fill" aria-hidden="true" className={`w-5 h-5 shrink-0 ${isLinkLoading ? '' : 'text-success'}`} />
          Share on WhatsApp
        </a>
        {hasShareSheet && (
          <button
            type="button"
            onClick={openShareSheet}
            // Not disabled: that would drop the focus to the page while the sheet is open. daisyUI
            // dims an aria-disabled button just as it does a disabled one.
            aria-disabled={isLinkLoading || isSharing || undefined}
            aria-describedby={noteId}
            className="btn flex-1 min-w-fit min-h-11 h-auto py-2 leading-tight rounded-xl font-semibold bg-base-100 border-base-300 hover:bg-base-200"
          >
            <ShareNetworkIcon weight="bold" aria-hidden="true" className="w-5 h-5 shrink-0" />
            Other apps
          </button>
        )}
        {canCopyText && (
          <button
            type="button"
            onClick={copyShareText}
            aria-disabled={isLinkLoading || undefined}
            aria-describedby={noteId}
            className="btn flex-1 min-w-fit min-h-11 h-auto py-2 leading-tight rounded-xl font-semibold bg-base-100 border-base-300 hover:bg-base-200"
          >
            <CopyIcon weight="bold" aria-hidden="true" className="w-5 h-5 shrink-0" />
            Copy message
          </button>
        )}
      </div>
      <p id={noteId} className="text-xs text-base-content/60 mt-2">
        {isLinkLoading
          ? 'Getting the link to this request…'
          : shareToken
            ? "Shares the blood group, units, hospital and urgency, plus a link that shows them while the request is open. Your name isn't included."
            : "Shares the blood group, units, hospital and urgency, plus Donor's web address. Your name isn't included."}
      </p>
    </div>
  );
};

export default ShareRequestButtons;
