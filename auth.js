/* ======================================================================
   ONE BULLET - auth.js
   ------------------------------------------------------------------
   Handles the account system: sign up / log in / log out through
   Supabase Auth, and syncing progress (best times per difficulty +
   endless bests) to a "profiles" table so it follows the player across
   devices. Falls back to localStorage for guests who skip login.

   Login/signup happen by USERNAME. Supabase Auth itself is still
   email + password under the hood, so signup also collects an email
   (kept private, never shown as the primary identity), and logging in
   looks up the email tied to that username via a database function
   before handing it to Supabase Auth. See the setup guide for the SQL.

   Loaded BEFORE script.js. Exposes a single global: `Account`.
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
      const name = (this.profile && this.profile.username) || 'PLAYER';
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
      game.endlessBest.run.room = data.endless_best_room;
    }
    if (data.endless_best_score !== null && data.endless_best_score !== undefined) {
      game.endlessBest.run.score = data.endless_best_score;
    }
    if (data.endless_best_time !== null && data.endless_best_time !== undefined) {
      game.endlessBest.run.time = data.endless_best_time;
    }
    if (data.endless_best_pace_score !== null && data.endless_best_pace_score !== undefined) {
      game.endlessBest.pace.metric = data.endless_best_pace_score;
      game.endlessBest.pace.room = data.endless_best_pace_room;
      game.endlessBest.pace.time = data.endless_best_pace_time;
      game.endlessBest.pace.score = data.endless_best_pace_run_score;
    }
    if (data.best_progress && typeof data.best_progress === 'object') {
      game.bestProgress = { ...game.bestProgress, ...data.best_progress };
    }

    // Lifetime totals: cloud value + anything earned but not uploaded yet,
    // so a background profile reload (e.g. token refresh) can't make the
    // displayed numbers dip.
    game.lifetime.rooms = (Number(data.total_rooms_cleared) || 0) + game.lifetimePending.rooms;
    game.lifetime.enemies = (Number(data.total_enemies_eliminated) || 0) + game.lifetimePending.enemies;
  },

  // Uploads lifetime totals earned since the last upload. Sends DELTAS to
  // add_player_totals() (atomic increment on the server) instead of
  // overwriting the row, so multiple devices/tabs can't clobber each
  // other. Fire-and-forget like syncProgress(): on failure the deltas are
  // put back and retried on the next flush.
  async flushStats() {
    if (!this.user) return;
    const rooms = game.lifetimePending.rooms;
    const enemies = game.lifetimePending.enemies;
    if (!rooms && !enemies) return;

    // Take the deltas out of "pending" up front so a kill that lands while
    // the request is in flight isn't sent twice or lost.
    game.lifetimePending.rooms -= rooms;
    game.lifetimePending.enemies -= enemies;

    const { error } = await supabaseClient
      .rpc('add_player_totals', { p_rooms: rooms, p_enemies: enemies });
    if (error) {
      console.error('flushStats error:', error);
      game.lifetimePending.rooms += rooms;
      game.lifetimePending.enemies += enemies;
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
      endless_best_room: game.endlessBest.run.room,
      endless_best_score: game.endlessBest.run.score,
      endless_best_time: game.endlessBest.run.time,
      endless_best_pace_score: game.endlessBest.pace.metric,
      endless_best_pace_room: game.endlessBest.pace.room,
      endless_best_pace_time: game.endlessBest.pace.time,
      endless_best_pace_run_score: game.endlessBest.pace.score,
      best_progress: game.bestProgress,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabaseClient.from('profiles').upsert(payload);
    if (error) console.error('syncProgress error:', error);
  },

  saveGuestProgress() {
    try {
      localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify({
        bestTimes: game.bestTimes,
        endlessBest: game.endlessBest,
        bestProgress: game.bestProgress
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
      if (data.bestProgress) game.bestProgress = { ...game.bestProgress, ...data.bestProgress };
    } catch (err) {
      // corrupt or missing - ignore
    }
  },

  /* ---------------- auth actions ---------------- */

  // username-based signup. Still needs an email under the hood (Supabase
  // Auth requirement) but the player never logs in with it again.
  async signUp(username, email, password) {
    const { data: available, error: availError } = await supabaseClient
      .rpc('is_username_available', { uname: username });
    if (availError) throw availError;
    if (!available) throw new Error('That username is already taken.');

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

  // username-based login: resolve the account's email server-side, then
  // hand it to Supabase Auth like a normal email/password sign-in.
  async signIn(username, password) {
    const { data: email, error: lookupError } = await supabaseClient
      .rpc('get_email_by_username', { uname: username });
    if (lookupError) throw lookupError;
    if (!email) throw new Error('Incorrect username or password.');

    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.message && error.message.toLowerCase().includes('email not confirmed')) {
        throw new Error('Confirm your email before logging in - check your inbox.');
      }
      throw new Error('Incorrect username or password.');
    }

    this.user = data.user;
    await this.loadProfile();
    return data;
  },

  async signOut() {
    // Must happen while still logged in - the upload needs the session.
    await this.flushStats();
    await supabaseClient.auth.signOut();
    this.user = null;
    this.profile = null;
    game.lifetime = { rooms: 0, enemies: 0 };
    game.lifetimePending = { rooms: 0, enemies: 0 };
    // Reset in-memory progress first: loadGuestProgress() MERGES whatever
    // it finds into `game`, and without this reset any pre-signup guest
    // save left in localStorage would overwrite matching fields of the
    // account's progress that was just showing, producing a confusing mix
    // of old guest numbers and account numbers instead of a clean switch.
    game.bestTimes = {};
    game.bestProgress = { easy: null, medium: null, hard: null };
    game.endlessBest = {
      run: { room: null, score: null, time: null },
      pace: { metric: null, room: null, time: null, score: null }
    };
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
  },

  /* ---------------- endless leaderboard ---------------- */

  // Top N players for a given metric ('score' | 'room' | 'pace'), via the
  // get_endless_leaderboard() SQL function (SECURITY DEFINER - see setup
  // guide). This intentionally does NOT read the "profiles" table
  // directly: that table is RLS-locked to each user's own row, and the
  // function is the only thing allowed to hand out other players'
  // username/stats publicly.
  async fetchLeaderboard(metric = 'score', limit = 100) {
    const { data, error } = await supabaseClient
      .rpc('get_endless_leaderboard', { p_metric: metric, p_limit: limit });
    if (error) {
      console.error('fetchLeaderboard error:', error);
      return [];
    }
    return data || [];
  },

  // Current user's rank + stats for that same metric, even when they fall
  // outside the top N. Guests have no cloud save, so there is nothing to
  // rank - null.
  async fetchMyRank(metric = 'score') {
    if (!this.user) return null;
    const { data, error } = await supabaseClient
      .rpc('get_endless_rank', { p_metric: metric, p_user_id: this.user.id });
    if (error) {
      console.error('fetchMyRank error:', error);
      return null;
    }
    return (data && data[0]) || null;
  },

  /* ---------------- public stats for one player (leaderboard tap) ---------------- */

  // Everything shown in another player's stats modal: official-level
  // bests/progress plus the full endless bests, including the pace
  // room/time pair. Like fetchLeaderboard()/fetchMyRank(), this goes
  // through a SECURITY DEFINER function rather than the "profiles"
  // table directly, since that table's RLS only allows reading your
  // own row - see the setup guide for the get_player_public_stats SQL.
  async fetchPlayerStats(userId) {
    if (!userId) return null;
    const { data, error } = await supabaseClient
      .rpc('get_player_public_stats', { p_user_id: userId });
    if (error) {
      console.error('fetchPlayerStats error:', error);
      return null;
    }
    return (data && data[0]) || null;
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
  const passwordConfirmInput = document.getElementById('auth-password-confirm');
  const errorEl = document.getElementById('auth-error');
  const submitBtn = document.getElementById('auth-submit');
  const btnBack = document.getElementById('btn-account-back');
  const btnLogout = document.getElementById('btn-account-logout');
  const profileAvatar = document.getElementById('profile-avatar');
  const profileUsername = document.getElementById('profile-username');

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  }

  function clearError() {
    errorEl.classList.add('hidden');
    errorEl.textContent = '';
  }

  function resetForm() {
    form.reset();
    clearError();
  }

  function applyTabFields() {
    const isSignup = Account.mode === 'signup';
    emailInput.classList.toggle('hidden', !isSignup);
    emailInput.required = isSignup;
    passwordConfirmInput.classList.toggle('hidden', !isSignup);
    passwordConfirmInput.required = isSignup;
    submitBtn.textContent = isSignup ? 'SIGN UP' : 'LOG IN';
  }

  function refreshAccountScreen() {
    if (Account.user) {
      guestView.classList.add('hidden');
      profileView.classList.remove('hidden');

      const name = (Account.profile && Account.profile.username) || 'PLAYER';
      profileUsername.textContent = name.toUpperCase();
      profileAvatar.textContent = name.charAt(0).toUpperCase();

      document.getElementById('stat-easy').textContent = getDifficultyBestLabel('easy');
      document.getElementById('stat-medium').textContent = getDifficultyBestLabel('medium');
      document.getElementById('stat-hard').textContent = getDifficultyBestLabel('hard');

      const bestRun = game.endlessBest.run;
      document.getElementById('stat-run-time').textContent =
        bestRun.time !== null && bestRun.time !== undefined ? formatTime(bestRun.time) : '--';
      document.getElementById('stat-run-score').textContent =
        bestRun.score !== null && bestRun.score !== undefined ? bestRun.score.toLocaleString() : '--';
      document.getElementById('stat-run-room').textContent =
        bestRun.room !== null && bestRun.room !== undefined ? bestRun.room : '--';

      const bestPace = game.endlessBest.pace;
      document.getElementById('stat-pace-time').textContent =
        bestPace.time !== null && bestPace.time !== undefined ? formatTime(bestPace.time) : '--';
      document.getElementById('stat-pace-score').textContent =
        bestPace.score !== null && bestPace.score !== undefined ? bestPace.score.toLocaleString() : '--';
      document.getElementById('stat-pace-room').textContent =
        bestPace.room !== null && bestPace.room !== undefined ? bestPace.room : '--';

      document.getElementById('stat-best-room').textContent =
        bestRun.room !== null && bestRun.room !== undefined ? bestRun.room : '--';
      document.getElementById('stat-rooms-cleared').textContent =
        game.lifetime.rooms.toLocaleString();
      document.getElementById('stat-enemies-eliminated').textContent =
        game.lifetime.enemies.toLocaleString();
    } else {
      guestView.classList.remove('hidden');
      profileView.classList.add('hidden');
      resetForm();
      applyTabFields();
    }
  }

  // Exposed so login/signup/logout can refresh the screen they're on.
  Account.refreshAccountScreen = refreshAccountScreen;

  chip.addEventListener('click', () => {
    refreshAccountScreen();
    showScreen(screenAccount);
  });

  btnBack.addEventListener('click', () => showScreen(screenMenu));

  btnLogout.addEventListener('click', async () => {
    await Account.signOut();
    refreshAccountScreen();
  });

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      Account.mode = tab.dataset.tab;
      resetForm();
      applyTabFields();
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const username = usernameInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const passwordConfirm = passwordConfirmInput.value;

    if (!username) {
      showError('Enter a username.');
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      showError('Username must be 3-20 characters: letters, numbers, underscores.');
      return;
    }

    submitBtn.disabled = true;
    try {
      if (Account.mode === 'signup') {
        if (!email) {
          showError("Enter an email - it's only used to recover your account.");
          return;
        }
        if (password !== passwordConfirm) {
          showError("Passwords don't match.");
          return;
        }
        const result = await Account.signUp(username, email, password);
        if (!result.session) {
          tabs[0].click(); // switch to the login tab...
          showError('Account created. Check your email to confirm it, then log in.'); // ...then show the message, so resetForm() doesn't wipe it
          return;
        }
      } else {
        await Account.signIn(username, password);
      }
      Account.updateChip();
      refreshAccountScreen();
    } catch (err) {
      showError(err.message || 'Something went wrong. Try again.');
    } finally {
      submitBtn.disabled = false;
    }
  });

  applyTabFields();
}