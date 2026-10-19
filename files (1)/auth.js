// ScanMyFood web: sign-in.
// With config.js > firebase filled in: Google and email sign-in, and every API call carries the Firebase ID token.
// Without it: guest mode, all data stays on this device.
const auth = { mode: 'guest', user: null };
const GUEST_FLAG = 'smf_guest';
const FB_VERSION = '10.12.5';

const loadScript = src => new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
  document.head.append(s);
});

const authLabel = () => auth.mode === 'firebase' ? (auth.user.displayName || auth.user.email || 'Signed in') : 'Guest';
const authUid = () => auth.mode === 'firebase' ? auth.user.uid : 'guest';

function friendlyAuthError(e) {
  const map = {
    'auth/invalid-credential': 'That email and password do not match.',
    'auth/wrong-password': 'That email and password do not match.',
    'auth/user-not-found': 'No account with that email. Choose "Create account".',
    'auth/email-already-in-use': 'That email already has an account. Choose "Sign in".',
    'auth/weak-password': 'Use a password with at least 6 characters.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/popup-closed-by-user': 'The Google window was closed before finishing.',
    'auth/popup-blocked': 'Your browser blocked the Google window. Allow pop-ups and try again.',
    'auth/unauthorized-domain': 'This address is not on the Firebase authorized domains list.',
    'auth/operation-not-supported-in-this-environment': 'Sign-in needs http://localhost or https, not a file:// page.',
    'auth/network-request-failed': 'No internet connection. Try again, or continue as a guest.',
  };
  return map[e.code] || 'Sign-in failed. Try again, or continue as a guest.';
}

function loginMarkup(fbReady) {
  return `<div class="login-card" role="dialog" aria-modal="true" aria-labelledby="login-title">
    <h2 id="login-title">ScanMyFood</h2>
    <p>Photograph what you eat and see what it does to your gut, skin, liver and kidneys. Sign in to keep your meals and streak on every device, or continue as a guest and keep them on this device.</p>
    ${fbReady ? `
      <button class="btn" id="lg-google" type="button">Continue with Google</button>
      <p class="or">or use email</p>
      <form id="lg-form">
        <label>Email<input id="lg-email" type="email" autocomplete="email" required></label>
        <label>Password<input id="lg-pass" type="password" autocomplete="current-password" minlength="6" required></label>
        <div class="login-row"><button class="btn" type="submit" data-mode="in">Sign in</button>
        <button class="btn alt" type="submit" data-mode="up">Create account</button></div>
      </form>` : `<p class="note">Account sign-in is not switched on yet. Add the Firebase web config in config.js to enable it.</p>`}
    <p id="login-msg" role="alert" class="login-msg"></p>
    <button class="btn ${fbReady ? 'ghost-ink' : 'alt'}" id="lg-guest" type="button">Continue as guest</button>
  </div>`;
}

function showLogin(fbReady, onDone, startMessage) {
  const box = document.getElementById('login');
  box.innerHTML = loginMarkup(fbReady);
  box.hidden = false;
  const msg = text => { document.getElementById('login-msg').textContent = text || ''; };
  if (startMessage) msg(startMessage);
  const finish = (mode, user) => { box.hidden = true; box.innerHTML = ''; onDone(mode, user); };

  document.getElementById('lg-guest').onclick = () => { localStorage.setItem(GUEST_FLAG, '1'); finish('guest', null); };
  if (!fbReady) return;
  const fb = firebase.auth();
  document.getElementById('lg-google').onclick = async () => {
    msg('');
    try { const r = await fb.signInWithPopup(new firebase.auth.GoogleAuthProvider()); finish('firebase', r.user); }
    catch (e) { msg(friendlyAuthError(e)); }
  };
  document.getElementById('lg-form').onsubmit = async ev => {
    ev.preventDefault(); msg('');
    const create = ev.submitter && ev.submitter.dataset.mode === 'up';
    const email = document.getElementById('lg-email').value.trim(), pass = document.getElementById('lg-pass').value;
    try {
      const r = create ? await fb.createUserWithEmailAndPassword(email, pass) : await fb.signInWithEmailAndPassword(email, pass);
      finish('firebase', r.user);
    } catch (e) { msg(friendlyAuthError(e)); }
  };
  document.getElementById('lg-email').focus();
}

// Resolves once the person is signed in or has chosen guest mode.
async function startAuth() {
  let fbReady = false, problem = '';
  if (CFG.firebase) {
    try {
      await loadScript(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-app-compat.js`);
      await loadScript(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-auth-compat.js`);
      firebase.initializeApp(CFG.firebase);
      window.getAuthToken = () => { const u = firebase.auth().currentUser; return u ? u.getIdToken() : null; };
      fbReady = true;
    } catch { problem = 'Sign-in could not load. Check your connection, or continue as a guest.'; }
  }
  if (fbReady) {
    const user = await new Promise(resolve => { const off = firebase.auth().onAuthStateChanged(u => { off(); resolve(u); }); });
    if (user) { auth.mode = 'firebase'; auth.user = user; return; }
  }
  if (localStorage.getItem(GUEST_FLAG) === '1') return;
  await new Promise(resolve => showLogin(fbReady, (mode, user) => { auth.mode = mode; auth.user = user; resolve(); }, problem));
}

async function signOut() {
  localStorage.removeItem(GUEST_FLAG);
  try { if (auth.mode === 'firebase') await firebase.auth().signOut(); } catch { /* reload anyway */ }
  location.reload();
}
