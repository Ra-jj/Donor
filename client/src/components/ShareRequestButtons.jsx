import { useId, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { WhatsappLogoIcon, ShareNetworkIcon, CopyIcon } from '@phosphor-icons/react';
import { buildRequestShareText, buildWhatsAppShareUrl } from '../lib/shareRequest';

/**
 * Lets a requester pass their own open request on to people who are not on Donor. WhatsApp
 * always, as that is where blood requests spread in India. Next to it, the device's share sheet
 * where the browser has one (phones, mostly); otherwise copying the text, to paste anywhere.
 *
 * @param {{ request: { bloodGroup: string, unitsNeeded: number, hospitalName: string, urgency: string } }} props
 */
const ShareRequestButtons = ({ request }) => {
  const noteId = useId();
  const [isSharing, setIsSharing] = useState(false);
  // Read synchronously, so a second press before the re-render is refused too
  const isSharingRef = useRef(false);
  const shareText = buildRequestShareText(request, `${window.location.origin}/`);
  const hasShareSheet = typeof navigator.share === 'function';
  const canCopyText = !hasShareSheet && typeof navigator.clipboard?.writeText === 'function';

  const openShareSheet = async () => {
    // A second share() while the sheet is still open is refused, so it waits for this one
    if (isSharingRef.current) return;
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
    try {
      await navigator.clipboard.writeText(shareText);
      toast.success('Message copied');
    } catch (error) {
      console.error('Copying the share text failed:', error);
      toast.error("Couldn't copy the message. Use Share on WhatsApp instead.");
    }
  };

  return (
    <div>
      {/* Side by side only when every label fits on one line, otherwise one control per row (phones):
          min-w-fit keeps a control from narrowing below its one-line width. A label too long even for
          a whole row (large text on a narrow phone) wraps instead, and h-auto lets its control get taller */}
      <div className="flex flex-wrap gap-2">
        <a
          href={buildWhatsAppShareUrl(shareText)}
          target="_blank"
          rel="noopener noreferrer"
          aria-describedby={noteId}
          className="btn flex-1 min-w-fit min-h-11 h-auto py-2 leading-tight rounded-xl font-bold text-base-content bg-success/10 border-success/20 hover:bg-success/20"
        >
          <WhatsappLogoIcon weight="fill" aria-hidden="true" className="w-5 h-5 shrink-0 text-success" />
          Share on WhatsApp
        </a>
        {hasShareSheet && (
          <button
            type="button"
            onClick={openShareSheet}
            // Not disabled: that would drop the focus to the page while the sheet is open. daisyUI
            // dims an aria-disabled button just as it does a disabled one.
            aria-disabled={isSharing || undefined}
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
            aria-describedby={noteId}
            className="btn flex-1 min-w-fit min-h-11 h-auto py-2 leading-tight rounded-xl font-semibold bg-base-100 border-base-300 hover:bg-base-200"
          >
            <CopyIcon weight="bold" aria-hidden="true" className="w-5 h-5 shrink-0" />
            Copy message
          </button>
        )}
      </div>
      <p id={noteId} className="text-xs text-base-content/60 mt-2">
        Shares the blood group, units, hospital and urgency, plus Donor's web address. Your name isn't included.
      </p>
    </div>
  );
};

export default ShareRequestButtons;
