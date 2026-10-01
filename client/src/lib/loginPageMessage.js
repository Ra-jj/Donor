import toast from 'react-hot-toast';
import { isPageReloading } from './pageReload';

const LOGIN_PAGE_MESSAGE_KEY = 'donor:loginPageMessage';

// Messages about a sign-out that ends on /login (an account deletion, or a session found expired on
// the privacy consent screen). The login page shows them, not the code that signs out: the route
// change to /login reloads the page if a new build has taken over (serviceWorkerUpdate.js), and a
// message shown before that reload would be lost with it.
const LOGIN_PAGE_MESSAGES = {
  accountDeleted: () => toast.success('Your account has been deleted'),
  accountGone: () => toast.success('This account no longer exists'),
  sessionEnded: () => toast.error('Your session has ended. Log in again to delete your account.'),
  sessionExpired: () => toast.error('Your session has ended. Please log in again.'),
};

// Call just before signing out. sessionStorage keeps the message through a reload of this window.
export const showOnLoginPage = (messageId) => {
  try {
    sessionStorage.setItem(LOGIN_PAGE_MESSAGE_KEY, messageId);
  } catch (error) {
    // Shown now instead, which a reload may lose, rather than never
    console.warn('Showing the message before /login: sessionStorage is unavailable', error);
    LOGIN_PAGE_MESSAGES[messageId]();
  }
};

// LoginPage calls this when it mounts. A page already reloading leaves the message for the page
// that loads next: whatever it shows now goes away with it.
export const showLoginPageMessage = () => {
  if (isPageReloading()) return;
  let messageId;
  try {
    messageId = sessionStorage.getItem(LOGIN_PAGE_MESSAGE_KEY);
    sessionStorage.removeItem(LOGIN_PAGE_MESSAGE_KEY);
  } catch {
    // Unavailable storage holds no message: showOnLoginPage showed it already
    return;
  }
  if (messageId && Object.hasOwn(LOGIN_PAGE_MESSAGES, messageId)) LOGIN_PAGE_MESSAGES[messageId]();
};

// A signed-in window has nothing left to say about a deletion: a message that never reached /login
// (e.g. a window on a path with no page) must not surface after a later, unrelated logout
export const clearLoginPageMessage = () => {
  try {
    sessionStorage.removeItem(LOGIN_PAGE_MESSAGE_KEY);
  } catch {
    // Unavailable storage holds no message
  }
};
