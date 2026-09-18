/* ======================================================================
   ONE BULLET - auth.js
   ------------------------------------------------------------------
   Handles the account system: sign up / log in / log out through
   Supabase Auth, and syncing progress (best times per difficulty +
   endless best) to a "profiles" table so it follows the player across
   devices. Falls back to localStorage for guests who skip login.

   Loaded BEFORE script.js. Exposes a single global: `Account`.
   `game` (defined in script.js) is read/written here once script.js
   has run its init(), which is the only place these functions get
   called from.
   ====================================================================== */

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const GUEST_STORAGE_KEY = 'onebullet_progress';

const Account = {
  user: null,     // Supabase auth user object, or null when logged out
  profile: null,  // row from the "profiles" table
  mode: 'login',  // which tab is active on the account screen: 'login' | 'signup'

  /* ---------------- lifecycle ---------------- */

  async init() {
    setupAccountUI();

    try {
      const { data } = await supabaseClient.auth.getSession();
      if (data.session) {
        this.user = data.session.user;
        await this.loadProfile();
      } else {
        this.loadGuestProgress();
      }
    } catch (err) {
      console.error('Account init error:', err);
      this.loadGuestProgress();
    }

    this.updateChip();

    supabaseClient.auth.onAuthStateChange(async (_event, session) => {
      this.user = session ? session.user : null;
      if (this.user) {
        await this.loadProfile();
      } else {
        this.profile = null;
      }
      this.updateChip();
    });
  },

  updateChip() {
    const label = document.getElementById('account-chip-label');
    if (!label) return;
    if (this.user) {
      const name = (this.profile && this.profile.username) || this.user.email.split('@')[0];
      label.textContent = name.toUpperCase();
    } else {
      label.textContent = 'GUEST';
    }
  },

  /* ---------------- cloud save / load ---------------- */

  async loadProfile() {
    if (!this.user) return;
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', this.user.id)
      .maybeSingle();

    if (error) {
      console.error('loadProfile error:', error);
      return;
    }

    this.profile = data;
    if (!data) return; // trigger hasn't created the row yet - syncProgress() will upsert it

    if (data.best_times && typeof data.best_times === 'object') {
      game.bestTimes = { ...game.bestTimes, ...data.best_times };
    }
    if (data.endless_best_room !== null && data.endless_best_room !== undefined) {
      game.endlessBest.room = data.endless_best_room;
    }
    if (data.endless_best_score !== null && data.endless_best_score !== undefined) {
      game.endlessBest.score = data.endless_best_score;
    }
  },

  // Push current in-memory bests up to Supabase (or localStorage as a
  // guest). Fire-and-forget - never blocks or interrupts gameplay if it
  // fails, e.g. while offline.
  async syncProgress() {
    if (!this.user) {
      this.saveGuestProgress();
      return;
    }

    const payload = {
      id: this.user.id,
      best_times: game.bestTimes,
      endless_best_room: game.endlessBest.room,
      endless_best_score: game.endlessBest.score,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabaseClient.from('profiles').upsert(payload);
    if (error) console.error('syncProgress error:', error);
  },

  saveGuestProgress() {
    try {
      localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify({
        bestTimes: game.bestTimes,
        endlessBest: game.endlessBest
      }));
    } catch (err) {
      // storage unavailable - not fatal
    }
  },

  loadGuestProgress() {
    try {
      const raw = localStorage.getItem(GUEST_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.bestTimes) game.bestTimes = { ...game.bestTimes, ...data.bestTimes };
      if (data.endlessBest) game.endlessBest = { ...game.endlessBest, ...data.endlessBest };
    } catch (err) {
      // corrupt or missing - ignore
    }
  },

  /* ---------------- auth actions ---------------- */

  async signUp(email, password, username) {
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: { data: { username } }
    });
    if (error) throw error;

    if (data.session) {
      // Email confirmation is OFF: we're logged in immediately.
      this.user = data.session.user;
      await this.claimUsername(username);
      await this.loadProfile();
      // Guest progress made before creating an account is not lost.
      await this.syncProgress();
    }
    return data;
  },

  async signIn(email, password) {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.user = data.user;
    await this.loadProfile();
    return data;
  },

  async signOut() {
    await supabaseClient.auth.signOut();
    this.user = null;
    this.profile = null;
    this.loadGuestProgress();
    this.updateChip();
  },

  // The auto-created profile row (via DB trigger, see setup guide) has no
  // username yet - fill it in right after signup.
  async claimUsername(username) {
    if (!this.user || !username) return;
    const { error } = await supabaseClient
      .from('profiles')
      .update({ username })
      .eq('id', this.user.id);
    if (error) console.error('claimUsername error:', error);
  }
};

/* ======================================================================
   ACCOUNT SCREEN UI
   ====================================================================== */

function setupAccountUI() {
  const chip = document.getElementById('btn-account');
  const screenAccount = document.getElementById('screen-account');
  const screenMenu = document.getElementById('screen-menu');
  const guestView = document.getElementById('account-guest-view');
  const profileView = document.getElementById('account-profile-view');
  const tabs = Array.from(document.querySelectorAll('.auth-tab'));
  const form = document.getElementById('auth-form');
  const usernameInput = document.getElementById('auth-username');
  const emailInput = document.getElementById('auth-email');
  const passwordInput = document.getElementById('auth-password');
  const errorEl = document.getElementById('auth-error');
  const submitBtn = document.getElementById('auth-submit');
  const accountEmail = document.getElementById('account-email');
  const btnBack = document.getElementById('btn-account-back');
  const btnGuest = document.getElementById('btn-account-guest');
  const btnLogout = document.getElementById('btn-account-logout');

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  }

  function clearError() {
    errorEl.classList.add('hidden');
    errorEl.textContent = '';
  }

  function refreshAccountScreen() {
    clearError();
    if (Account.user) {
      guestView.classList.add('hidden');
      profileView.classList.remove('hidden');
      accountEmail.textContent = Account.user.email;

      document.getElementById('stat-easy').textContent =
        game.bestTimes.easy !== undefined ? formatTime(game.bestTimes.easy) : '--';
      document.getElementById('stat-medium').textContent =
        game.bestTimes.medium !== undefined ? formatTime(game.bestTimes.medium) : '--';
      document.getElementById('stat-hard').textContent =
        game.bestTimes.hard !== undefined ? formatTime(game.bestTimes.hard) : '--';
      document.getElementById('stat-endless').textContent =
        game.endlessBest.score !== null
          ? `ROOM ${game.endlessBest.room} \u00b7 ${game.endlessBest.score.toLocaleString()}`
          : '--';
    } else {
      guestView.classList.remove('hidden');
      profileView.classList.add('hidden');
      form.reset();
    }
  }

  // Exposed so login/signup/logout can refresh the screen they're on.
  Account.refreshAccountScreen = refreshAccountScreen;

  chip.addEventListener('click', () => {
    refreshAccountScreen();
    showScreen(screenAccount);
  });

  btnBack.addEventListener('click', () => showScreen(screenMenu));
  btnGuest.addEventListener('click', () => showScreen(screenMenu));

  btnLogout.addEventListener('click', async () => {
    await Account.signOut();
    refreshAccountScreen();
  });

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      Account.mode = tab.dataset.tab;
      usernameInput.classList.toggle('hidden', Account.mode !== 'signup');
      submitBtn.textContent = Account.mode === 'signup' ? 'SIGN UP' : 'LOG IN';
      clearError();
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const username = usernameInput.value.trim();

    submitBtn.disabled = true;
    try {
      if (Account.mode === 'signup') {
        if (!username) {
          showError('Pick a username.');
          return;
        }
        const result = await Account.signUp(email, password, username);
        if (!result.session) {
          showError('Account created. Check your email to confirm it, then log in.');
          tabs[0].click();
          return;
        }
      } else {
        await Account.signIn(email, password);
      }
      Account.updateChip();
      refreshAccountScreen();
    } catch (err) {
      showError(err.message || 'Something went wrong. Try again.');
    } finally {
      submitBtn.disabled = false;
    }
  });
}
