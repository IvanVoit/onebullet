/* ======================================================================
   ONE BULLET - script.js
   2D aiming / ricochet game built with HTML5 Canvas and vanilla JS.
   ====================================================================== */

/* ======================================================================
   1. CONFIGURATION
   ====================================================================== */

const CONFIG = {
  canvasWidth: 960,
  canvasHeight: 600,
  border: 24,              // thickness of the outer walls

  playerRadius: 14,
  playerSpeed: 240,        // px per second

  bulletRadius: 6,
  bulletSpeed: 820,        // px per second at the moment of firing
  bulletDrag: 0.12,        // fraction of speed lost per second (friction)
  bulletMinSpeed: 55,      // below this the bullet counts as spent
  bulletMaxLifetime: 5,    // seconds after firing before the attempt fails
  timeBonusOnKill: 3,      // seconds given back for every enemy killed
  bulletSubstepSize: 4,    // size (px) of each micro-step, prevents tunneling

  predictionBounces: 3,    // number of bounces drawn by the aim line
  predictionStep: 6,       // sampling resolution of the aim line

  particleCount: 14,

  colors: {
    player: '#4fd8c4',
    playerGlow: 'rgba(79, 216, 196, 0.45)',
    enemy: '#ef4b5f',
    enemyGlow: 'rgba(239, 75, 95, 0.45)',
    bullet: '#ffcf5c',
    bulletGlow: 'rgba(255, 207, 92, 0.65)',
    wall: '#1c2531',
    wallBorder: '#33445a',
    prediction: 'rgba(255, 207, 92, 0.35)',
    success: '#4ade80',
    fail: '#ef4b5f',
    bg: '#0a0e14'
  }
};

/* ======================================================================
   1b. KEYBINDS
   ------------------------------------------------------------------
   Movement, retry and menu keys can be remapped from Settings > Controls.
   Arrow keys always move the player too, as a fixed, non-removable
   backup - only the WASD-style primary keys and the action keys below
   are actually configurable.
   ====================================================================== */

const DEFAULT_KEYBINDS = {
  up: 'w',
  down: 's',
  left: 'a',
  right: 'd',
  retry: 'r',
  next: ' ',
  pause: 'escape'
};

let KEYBINDS = { ...DEFAULT_KEYBINDS };

function saveKeybinds() {
  try {
    localStorage.setItem('onebullet_keybinds', JSON.stringify(KEYBINDS));
  } catch (err) {
    // storage unavailable (private browsing, etc.) - not fatal, just skip
  }
}

function loadKeybinds() {
  try {
    const raw = localStorage.getItem('onebullet_keybinds');
    if (raw) KEYBINDS = { ...DEFAULT_KEYBINDS, ...JSON.parse(raw) };
  } catch (err) {
    KEYBINDS = { ...DEFAULT_KEYBINDS };
  }
}

// Turns a stored key value into the label shown on its rebind button.
function keyDisplayName(key) {
  const names = {
    ' ': 'SPACE',
    'escape': 'ESC',
    'arrowup': 'UP ARROW',
    'arrowdown': 'DOWN ARROW',
    'arrowleft': 'LEFT ARROW',
    'arrowright': 'RIGHT ARROW'
  };
  return names[key] || key.toUpperCase();
}

// Set while a "PRESS A KEY" rebind button is waiting for input; the very
// next keydown gets captured as that action's new binding instead of
// being treated as a normal game hotkey.
let listeningForAction = null;

function captureKeybind(action, key) {
  KEYBINDS[action] = key;
  saveKeybinds();
  listeningForAction = null;
  renderControlsScreen();
}

/* ======================================================================
   2. GAME STATE
   ====================================================================== */

const STATE = {
  MENU: 'menu',
  DIFFICULTY: 'difficulty',
  MODE: 'mode',
  SETTINGS: 'settings',
  CONTROLS: 'controls',
  HOWTOPLAY: 'howtoplay',
  PLAYING: 'playing',
  PAUSED: 'paused',
  WIN: 'win',
  LOSE: 'lose',
  FAILED: 'failed',
  COMPLETE: 'complete',
  ENDLESS_OVER: 'endless_over'
};

const game = {
  state: STATE.MENU,
  difficulty: 'medium',   // 'easy' | 'medium' | 'hard' - set from the menu
  mode: 'normal',         // 'normal' = one continuous run | 'practice' = stay on the room
  levels: null,           // points at the 10-level set of the chosen difficulty
  currentLevelIndex: 0,

  player: null,          // { x, y, vx, vy }
  bullet: null,          // { x, y, vx, vy, active, lifetime }
  bulletFired: false,
  walls: [],             // active walls of the current room (borders + level)
  enemies: [],           // active enemies of the current room
  particles: [],

  mouse: { x: CONFIG.canvasWidth / 2, y: CONFIG.canvasHeight / 2 },
  keys: {},

  // --- Timing (for speedrunning) ---
  timerStarted: false, // the clock only starts once you actually move or fire
  roomTime: 0,        // seconds spent in the current room
  runTime: 0,         // seconds accumulated across the whole run
  lastRoomTime: 0,    // room time frozen when the room ended
  bestTimes: {},      // best completed-run time per difficulty
  // Furthest room reached (1-based) on a difficulty NOT yet completed.
  // Once bestTimes[difficulty] exists, this stops being shown (the time
  // takes over), but it's kept around in case a save gets loaded oddly.
  bestProgress: { easy: null, medium: null, hard: null },

  // --- Endless mode ---
  endless: false,           // true while an Endless run is active
  endlessRoom: 1,            // current room number (1-based, infinite)
  endlessScore: 0,           // current run's score
  endlessRoomEnemyCount: 0,  // enemies the current room started with (for scoring)
  // True during the short pause after clearing a room, before the next one
  // spawns. The HUD clock (and score-relevant runTime) simply holds still
  // during this pause instead of continuing to tick.
  endlessTransitioning: false,
  // Kept around for future competitive features (best room / best score /
  // fastest clear / leaderboards). Only tracked in memory for now.
  endlessBest: { room: null, score: null, time: null },

  lastTimestamp: 0
};

/* ======================================================================
   3. LEVELS
   ------------------------------------------------------------------
   Every level is a plain object with:
     - player: starting position of the player
     - enemies: array of positions { x, y }
     - walls: array of inner obstacles { x, y, w, h }
       (the 4 outer walls of the room are added automatically, there is
        no need to declare them here)

   There are 3 sets of 10 rooms, one per difficulty. EASY and HARD are
   derived from MEDIUM (which was already play-tested) in two safe ways
   that keep every room solvable:
     - EASY  = subsets of a MEDIUM room (same valid firing angles, just
               fewer targets / obstacles along the way).
     - HARD  = the MEDIUM room itself mirrored (horizontally or
               vertically). Mirroring right-angled wall geometry keeps
               the bounce physics exactly the same, so if the original
               was solvable the mirror is solvable too.
   ====================================================================== */

const MEDIUM_LEVELS = [

  // ROOM 1 - intro, straight shot
  {
    player: { x: 90, y: 300 },
    walls: [],
    enemies: [
      { x: 860, y: 300 }
    ]
  },

  // ROOM 2 - a single bounce off the top wall chains 2 enemies
  {
    player: { x: 90, y: 300 },
    walls: [],
    enemies: [
      { x: 420, y: 90 },
      { x: 614, y: 292 }
    ]
  },

  // ROOM 3 - 3 aligned enemies, plus a decorative obstacle
  {
    player: { x: 90, y: 300 },
    walls: [
      { x: 300, y: 400, w: 140, h: 90 }
    ],
    enemies: [
      { x: 400, y: 207 },
      { x: 600, y: 147 },
      { x: 850, y: 72 }
    ]
  },

  // ROOM 4 - a central obstacle forces a bounce off the right wall
  {
    player: { x: 90, y: 150 },
    walls: [
      { x: 480, y: 190, w: 30, h: 230 }
    ],
    enemies: [
      { x: 700, y: 450 },
      { x: 459, y: 517 }
    ]
  },

  // ROOM 5 - room split in two, go around the top or the bottom
  {
    player: { x: 90, y: 300 },
    walls: [
      { x: 460, y: 24, w: 26, h: 220 },
      { x: 460, y: 356, w: 26, h: 220 }
    ],
    enemies: [
      { x: 620, y: 120 },
      { x: 620, y: 300 },
      { x: 620, y: 480 }
    ]
  },

  // ROOM 6 - zig-zag corridor
  {
    player: { x: 60, y: 60 },
    walls: [
      { x: 200, y: 24, w: 26, h: 340 },
      { x: 420, y: 236, w: 26, h: 340 },
      { x: 640, y: 24, w: 26, h: 340 }
    ],
    enemies: [
      { x: 300, y: 500 },
      { x: 520, y: 90 },
      { x: 760, y: 500 },
      { x: 880, y: 90 }
    ]
  },

  // ROOM 7 - double bounce required (top corner)
  {
    player: { x: 480, y: 540 },
    walls: [
      { x: 260, y: 300, w: 200, h: 26 },
      { x: 620, y: 260, w: 26, h: 200 }
    ],
    enemies: [
      { x: 120, y: 100 },
      { x: 480, y: 90 },
      { x: 840, y: 130 },
      { x: 860, y: 400 }
    ]
  },

  // ROOM 8 - chamber with pillars
  {
    player: { x: 90, y: 300 },
    walls: [
      { x: 300, y: 130, w: 40, h: 40 },
      { x: 300, y: 430, w: 40, h: 40 },
      { x: 560, y: 280, w: 40, h: 40 },
      { x: 780, y: 130, w: 40, h: 40 },
      { x: 780, y: 430, w: 40, h: 40 }
    ],
    enemies: [
      { x: 460, y: 90 },
      { x: 460, y: 510 },
      { x: 900, y: 300 },
      { x: 660, y: 460 },
      { x: 660, y: 140 }
    ]
  },

  // ROOM 9 - cross-shaped room, needs careful planning
  {
    player: { x: 480, y: 300 },
    walls: [
      { x: 24, y: 200, w: 300, h: 26 },
      { x: 636, y: 200, w: 300, h: 26 },
      { x: 24, y: 374, w: 300, h: 26 },
      { x: 636, y: 374, w: 300, h: 26 }
    ],
    enemies: [
      { x: 480, y: 60 },
      { x: 480, y: 540 },
      { x: 70, y: 300 },
      { x: 890, y: 300 },
      { x: 480, y: 299 }
    ]
  },

  // ROOM 10 - the final room, everything above combined
  {
    player: { x: 480, y: 560 },
    walls: [
      { x: 140, y: 240, w: 26, h: 320 },
      { x: 794, y: 240, w: 26, h: 320 },
      { x: 300, y: 100, w: 360, h: 26 },
      { x: 460, y: 300, w: 40, h: 40 }
    ],
    enemies: [
      { x: 90, y: 90 },
      { x: 870, y: 90 },
      { x: 90, y: 480 },
      { x: 870, y: 480 },
      { x: 480, y: 190 },
      { x: 480, y: 500 }
    ]
  }
];

const EASY_LEVELS = [

  // E1 - straight shot, a single enemy
  { player: { x: 90, y: 300 }, walls: [], enemies: [{ x: 860, y: 300 }] },

  // E2 - two enemies on the same straight line
  { player: { x: 90, y: 300 }, walls: [], enemies: [{ x: 500, y: 300 }, { x: 860, y: 300 }] },

  // E3 - three enemies on the same straight line
  { player: { x: 90, y: 300 }, walls: [], enemies: [{ x: 340, y: 300 }, { x: 600, y: 300 }, { x: 860, y: 300 }] },

  // E4 - straight diagonal shot
  { player: { x: 90, y: 90 }, walls: [], enemies: [{ x: 475, y: 300 }, { x: 860, y: 510 }] },

  // E5 - first bounce: one enemy behind the top wall
  { player: { x: 90, y: 300 }, walls: [], enemies: [{ x: 614, y: 292 }] },

  // E6 - same bounce, now chaining 2 enemies
  { player: { x: 90, y: 300 }, walls: [], enemies: [{ x: 420, y: 90 }, { x: 614, y: 292 }] },

  // E7 - diagonal line with a decorative obstacle in the room
  { player: { x: 90, y: 300 }, walls: [{ x: 300, y: 400, w: 140, h: 90 }], enemies: [{ x: 400, y: 207 }, { x: 850, y: 72 }] },

  // E8 - the same diagonal, now with all 3 enemies
  { player: { x: 90, y: 300 }, walls: [{ x: 300, y: 400, w: 140, h: 90 }], enemies: [{ x: 400, y: 207 }, { x: 600, y: 147 }, { x: 850, y: 72 }] },

  // E9 - an obstacle forces a small detour, one enemy
  { player: { x: 90, y: 150 }, walls: [{ x: 480, y: 190, w: 30, h: 230 }], enemies: [{ x: 459, y: 517 }] },

  // E10 - easy finale, with both enemies
  { player: { x: 90, y: 150 }, walls: [{ x: 480, y: 190, w: 30, h: 230 }], enemies: [{ x: 700, y: 450 }, { x: 459, y: 517 }] }
];

const HARD_LEVELS = [

  // H1 - zig-zag, mirrored horizontally
  { player: { x: 900, y: 60 }, walls: [{ x: 734, y: 24, w: 26, h: 340 }, { x: 514, y: 236, w: 26, h: 340 }, { x: 294, y: 24, w: 26, h: 340 }], enemies: [{ x: 660, y: 500 }, { x: 440, y: 90 }, { x: 200, y: 500 }, { x: 80, y: 90 }] },

  // H2 - corner double bounce, mirrored horizontally
  { player: { x: 480, y: 540 }, walls: [{ x: 500, y: 300, w: 200, h: 26 }, { x: 314, y: 260, w: 26, h: 200 }], enemies: [{ x: 840, y: 100 }, { x: 480, y: 90 }, { x: 120, y: 130 }, { x: 100, y: 400 }] },

  // H3 - pillar chamber, mirrored vertically
  { player: { x: 90, y: 300 }, walls: [{ x: 300, y: 430, w: 40, h: 40 }, { x: 300, y: 130, w: 40, h: 40 }, { x: 560, y: 280, w: 40, h: 40 }, { x: 780, y: 430, w: 40, h: 40 }, { x: 780, y: 130, w: 40, h: 40 }], enemies: [{ x: 460, y: 510 }, { x: 460, y: 90 }, { x: 900, y: 300 }, { x: 660, y: 140 }, { x: 660, y: 460 }] },

  // H4 - cross-shaped room, mirrored horizontally
  { player: { x: 480, y: 300 }, walls: [{ x: 636, y: 200, w: 300, h: 26 }, { x: 24, y: 200, w: 300, h: 26 }, { x: 636, y: 374, w: 300, h: 26 }, { x: 24, y: 374, w: 300, h: 26 }], enemies: [{ x: 480, y: 60 }, { x: 480, y: 540 }, { x: 890, y: 300 }, { x: 70, y: 300 }, { x: 480, y: 299 }] },

  // H5 - final room, mirrored horizontally
  { player: { x: 480, y: 560 }, walls: [{ x: 794, y: 240, w: 26, h: 320 }, { x: 140, y: 240, w: 26, h: 320 }, { x: 300, y: 100, w: 360, h: 26 }, { x: 460, y: 300, w: 40, h: 40 }], enemies: [{ x: 870, y: 90 }, { x: 90, y: 90 }, { x: 870, y: 480 }, { x: 90, y: 480 }, { x: 480, y: 190 }, { x: 480, y: 500 }] },

  // H6 - original zig-zag, the most demanding of the mid-tier rooms
  { player: { x: 60, y: 60 }, walls: [{ x: 200, y: 24, w: 26, h: 340 }, { x: 420, y: 236, w: 26, h: 340 }, { x: 640, y: 24, w: 26, h: 340 }], enemies: [{ x: 300, y: 500 }, { x: 520, y: 90 }, { x: 760, y: 500 }, { x: 880, y: 90 }] },

  // H7 - original corner double bounce
  { player: { x: 480, y: 540 }, walls: [{ x: 260, y: 300, w: 200, h: 26 }, { x: 620, y: 260, w: 26, h: 200 }], enemies: [{ x: 120, y: 100 }, { x: 480, y: 90 }, { x: 840, y: 130 }, { x: 860, y: 400 }] },

  // H8 - original pillar chamber, 5 enemies
  { player: { x: 90, y: 300 }, walls: [{ x: 300, y: 130, w: 40, h: 40 }, { x: 300, y: 430, w: 40, h: 40 }, { x: 560, y: 280, w: 40, h: 40 }, { x: 780, y: 130, w: 40, h: 40 }, { x: 780, y: 430, w: 40, h: 40 }], enemies: [{ x: 460, y: 90 }, { x: 460, y: 510 }, { x: 900, y: 300 }, { x: 660, y: 460 }, { x: 660, y: 140 }] },

  // H9 - original cross room, needs pixel-perfect planning
  { player: { x: 480, y: 300 }, walls: [{ x: 24, y: 200, w: 300, h: 26 }, { x: 636, y: 200, w: 300, h: 26 }, { x: 24, y: 374, w: 300, h: 26 }, { x: 636, y: 374, w: 300, h: 26 }], enemies: [{ x: 480, y: 60 }, { x: 480, y: 540 }, { x: 70, y: 300 }, { x: 890, y: 300 }, { x: 480, y: 299 }] },

  // H10 - the final boss room: 6 enemies, everything combined
  { player: { x: 480, y: 560 }, walls: [{ x: 140, y: 240, w: 26, h: 320 }, { x: 794, y: 240, w: 26, h: 320 }, { x: 300, y: 100, w: 360, h: 26 }, { x: 460, y: 300, w: 40, h: 40 }], enemies: [{ x: 90, y: 90 }, { x: 870, y: 90 }, { x: 90, y: 480 }, { x: 870, y: 480 }, { x: 480, y: 190 }, { x: 480, y: 500 }] }
];

const LEVEL_SETS = {
  easy: EASY_LEVELS,
  medium: MEDIUM_LEVELS,
  hard: HARD_LEVELS
};

/* ======================================================================
   4. INPUT
   ====================================================================== */

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

function setupInput() {
  window.addEventListener('keydown', (e) => {
    game.keys[e.key.toLowerCase()] = true;
  });

  window.addEventListener('keyup', (e) => {
    game.keys[e.key.toLowerCase()] = false;
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = CONFIG.canvasWidth / rect.width;
    const scaleY = CONFIG.canvasHeight / rect.height;
    game.mouse.x = (e.clientX - rect.left) * scaleX;
    game.mouse.y = (e.clientY - rect.top) * scaleY;
  });

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // left click only
    if (game.state === STATE.PLAYING && !game.bulletFired) {
      fireBullet();
    }
  });

  // Keep the right-click context menu out of the way
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function isMovingUp()    { return game.keys[KEYBINDS.up] || game.keys['arrowup']; }
function isMovingDown()  { return game.keys[KEYBINDS.down] || game.keys['arrowdown']; }
function isMovingLeft()  { return game.keys[KEYBINDS.left] || game.keys['arrowleft']; }
function isMovingRight() { return game.keys[KEYBINDS.right] || game.keys['arrowright']; }

/* ======================================================================
   5. PLAYER
   ====================================================================== */

function createPlayer(x, y) {
  return { x, y, vx: 0, vy: 0 };
}

function updatePlayer(dt) {
  const p = game.player;
  let dx = 0;
  let dy = 0;

  if (isMovingUp()) dy -= 1;
  if (isMovingDown()) dy += 1;
  if (isMovingLeft()) dx -= 1;
  if (isMovingRight()) dx += 1;

  // Normalise so diagonal movement is not faster
  if (dx !== 0 && dy !== 0) {
    const len = Math.sqrt(2);
    dx /= len;
    dy /= len;
  }

  p.vx = dx * CONFIG.playerSpeed;
  p.vy = dy * CONFIG.playerSpeed;

  // Smooth movement with axis-by-axis collision resolution
  moveCircleWithCollision(p, p.vx * dt, 0, CONFIG.playerRadius, game.walls);
  moveCircleWithCollision(p, 0, p.vy * dt, CONFIG.playerRadius, game.walls);
}

// Moves a circle by (dx, dy) resolving collisions against walls,
// sliding along them instead of passing through.
function moveCircleWithCollision(entity, dx, dy, radius, walls) {
  entity.x += dx;
  entity.y += dy;

  for (const wall of walls) {
    const res = circleRectCollision(entity.x, entity.y, radius, wall);
    if (res.colliding) {
      // pushX/pushY point AWAY from the wall: always add, never subtract.
      entity.x += res.pushX;
      entity.y += res.pushY;
    }
  }

  // canvas bounds (a safety net, the outer walls already constrain us)
  entity.x = clamp(entity.x, radius, CONFIG.canvasWidth - radius);
  entity.y = clamp(entity.y, radius, CONFIG.canvasHeight - radius);
}

/* ======================================================================
   6. BULLET
   ====================================================================== */

function fireBullet() {
  const p = game.player;
  const dx = game.mouse.x - p.x;
  const dy = game.mouse.y - p.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;

  game.bullet = {
    x: p.x,
    y: p.y,
    vx: (dx / len) * CONFIG.bulletSpeed,
    vy: (dy / len) * CONFIG.bulletSpeed,
    active: true,
    lifetime: 0
  };

  game.bulletFired = true;
  spawnMuzzleParticles(p.x, p.y, dx / len, dy / len);
  updateHudBulletStatus();
}

function updateBullet(dt) {
  const b = game.bullet;
  if (!b || !b.active) return;

  b.lifetime += dt;

  // Friction: the bullet loses speed over time
  const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  const newSpeed = Math.max(0, speed * (1 - CONFIG.bulletDrag * dt));
  if (speed > 0) {
    b.vx = (b.vx / speed) * newSpeed;
    b.vy = (b.vy / speed) * newSpeed;
  }

  // Sub-steps so the bullet cannot tunnel through walls at high speed
  const totalDist = newSpeed * dt;
  const steps = Math.max(1, Math.ceil(totalDist / CONFIG.bulletSubstepSize));
  const stepDx = (b.vx * dt) / steps;
  const stepDy = (b.vy * dt) / steps;

  for (let i = 0; i < steps; i++) {
    if (!b.active) break;

    b.x += stepDx;
    b.y += stepDy;

    // wall collision: bounce
    for (const wall of game.walls) {
      const res = circleRectCollision(b.x, b.y, CONFIG.bulletRadius, wall);
      if (res.colliding) {
        // Push the bullet out of the wall BEFORE reflecting its velocity.
        b.x += res.pushX;
        b.y += res.pushY;

        // True vector reflection against the collision normal: this fixes
        // the "sliding" bug on grazing angles and corners, because it does
        // not rely on guessing whether the wall is vertical or horizontal.
        const reflected = reflectVelocity(b.vx, b.vy, res.normalX, res.normalY);
        b.vx = reflected.vx;
        b.vy = reflected.vy;

        spawnImpactParticles(b.x, b.y, CONFIG.colors.bullet);
      }
    }

    // enemy collision: they die, the bullet carries on and gains extra time
    for (let e = game.enemies.length - 1; e >= 0; e--) {
      const enemy = game.enemies[e];
      const dx = b.x - enemy.x;
      const dy = b.y - enemy.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < CONFIG.bulletRadius + enemy.radius) {
        killEnemy(e);
        b.lifetime = Math.max(0, b.lifetime - CONFIG.timeBonusOnKill);
        flashTimerBonus();
      }
    }

    if (game.enemies.length === 0) {
      endRoom(true);
      return;
    }
  }

  // attempt-ending conditions without a win
  if (newSpeed <= CONFIG.bulletMinSpeed || b.lifetime >= CONFIG.bulletMaxLifetime) {
    b.active = false;
    endRoom(false);
  }
}

// Computes (without really colliding) the predicted bullet path, used to
// draw the aim line while the shot is still available.
function computePredictionPath() {
  const p = game.player;
  const dx = game.mouse.x - p.x;
  const dy = game.mouse.y - p.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;

  let x = p.x;
  let y = p.y;
  let vx = (dx / len) * CONFIG.predictionStep;
  let vy = (dy / len) * CONFIG.predictionStep;

  const points = [{ x, y }];
  let bounces = 0;
  let iterations = 0;
  const maxIterations = 2000;

  while (bounces <= CONFIG.predictionBounces && iterations < maxIterations) {
    iterations++;
    x += vx;
    y += vy;

    for (const wall of game.walls) {
      const res = circleRectCollision(x, y, CONFIG.bulletRadius, wall);
      if (res.colliding) {
        x += res.pushX;
        y += res.pushY;
        const reflected = reflectVelocity(vx, vy, res.normalX, res.normalY);
        vx = reflected.vx;
        vy = reflected.vy;
        bounces++;
        break;
      }
    }

    points.push({ x, y });
  }

  return points;
}

/* ======================================================================
   7. ENEMIES
   ====================================================================== */

function createEnemy(x, y) {
  return { x, y, radius: 16, alive: true };
}

function killEnemy(index) {
  const enemy = game.enemies[index];
  spawnImpactParticles(enemy.x, enemy.y, CONFIG.colors.enemy);
  game.enemies.splice(index, 1);
  updateHudEnemyCount();
}

/* ======================================================================
   8. COLLISION DETECTION
   ====================================================================== */

// Circle vs rectangle (AABB) collision with a true collision normal.
// Unlike a plain "flip one axis" approach, this finds the closest point
// of the rectangle to the circle and reflects the velocity against that
// real normal, so grazing angles and corners bounce correctly instead
// of sliding along the wall.
const COLLISION_EPSILON = 0.6; // extra separation margin, avoids re-hits in the same frame

function circleRectCollision(cx, cy, radius, rect) {
  const closestX = clamp(cx, rect.x, rect.x + rect.w);
  const closestY = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - closestX;
  const dy = cy - closestY;
  const distSq = dx * dx + dy * dy;

  if (distSq > 0) {
    // Normal case: the centre is outside the rectangle (or right on the edge).
    if (distSq >= radius * radius) return { colliding: false };
    const dist = Math.sqrt(distSq);
    const nx = dx / dist;
    const ny = dy / dist;
    const penetration = radius - dist + COLLISION_EPSILON;
    return { colliding: true, pushX: nx * penetration, pushY: ny * penetration, normalX: nx, normalY: ny };
  }

  // Rare case (tunneling): the centre is already inside the rectangle.
  // Exit through the side of least penetration as a safety net.
  const rectCenterX = rect.x + rect.w / 2;
  const rectCenterY = rect.y + rect.h / 2;
  const halfW = rect.w / 2 + radius;
  const halfH = rect.h / 2 + radius;
  const ddx = cx - rectCenterX;
  const ddy = cy - rectCenterY;
  const overlapX = halfW - Math.abs(ddx);
  const overlapY = halfH - Math.abs(ddy);

  if (overlapX < overlapY) {
    const nx = ddx >= 0 ? 1 : -1;
    return { colliding: true, pushX: nx * (overlapX + COLLISION_EPSILON), pushY: 0, normalX: nx, normalY: 0 };
  } else {
    const ny = ddy >= 0 ? 1 : -1;
    return { colliding: true, pushX: 0, pushY: ny * (overlapY + COLLISION_EPSILON), normalX: 0, normalY: ny };
  }
}

// Reflects a velocity vector (vx, vy) against a collision normal (nx, ny).
// Only reflects when the object is actually moving INTO the surface.
function reflectVelocity(vx, vy, nx, ny) {
  const dot = vx * nx + vy * ny;
  if (dot >= 0) return { vx, vy }; // already moving away, do not reflect
  return { vx: vx - 2 * dot * nx, vy: vy - 2 * dot * ny };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/* ======================================================================
   9. PHYSICS (helper constants for sub-stepping)
   ====================================================================== */

// The bullet sub-stepping lives inside updateBullet() so it has direct
// access to collisions and enemy deaths in the same loop, but the physics
// constants are centralised here for clarity.
const PHYSICS = {
  substepSize: CONFIG.bulletSubstepSize
};

/* ======================================================================
   10. PARTICLES
   ====================================================================== */

function spawnImpactParticles(x, y, color) {
  for (let i = 0; i < CONFIG.particleCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 160;
    game.particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.35 + Math.random() * 0.25,
      age: 0,
      color
    });
  }
}

function spawnMuzzleParticles(x, y, dirX, dirY) {
  for (let i = 0; i < 8; i++) {
    const spread = (Math.random() - 0.5) * 0.8;
    const angle = Math.atan2(dirY, dirX) + spread;
    const speed = 200 + Math.random() * 150;
    game.particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.2 + Math.random() * 0.15,
      age: 0,
      color: CONFIG.colors.bullet
    });
  }
}

function updateParticles(dt) {
  for (let i = game.particles.length - 1; i >= 0; i--) {
    const particle = game.particles[i];
    particle.age += dt;
    if (particle.age >= particle.life) {
      game.particles.splice(i, 1);
      continue;
    }
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vx *= 0.92;
    particle.vy *= 0.92;
  }
}

/* ======================================================================
   11. RENDERING
   ------------------------------------------------------------------
   Everything is a simple shape for now. Replace the body of these
   functions (drawPlayer, drawEnemy, drawBullet, drawWall) with your own
   sprites / images whenever you want.
   ====================================================================== */

function drawBackground() {
  ctx.fillStyle = CONFIG.colors.bg;
  ctx.fillRect(0, 0, CONFIG.canvasWidth, CONFIG.canvasHeight);

  // subtle background grid to sell the "room" feeling
  ctx.strokeStyle = 'rgba(255,255,255,0.02)';
  ctx.lineWidth = 1;
  for (let x = 0; x < CONFIG.canvasWidth; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, CONFIG.canvasHeight);
    ctx.stroke();
  }
  for (let y = 0; y < CONFIG.canvasHeight; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(CONFIG.canvasWidth, y);
    ctx.stroke();
  }
}

// --- SPRITE SLOT ---
// To use an image, draw `ctx.drawImage(playerSprite, x - w/2, y - h/2, w, h)`
// here instead of the arc. Load the image up in the configuration section.
function drawPlayer(p) {
  ctx.save();
  ctx.shadowColor = CONFIG.colors.playerGlow;
  ctx.shadowBlur = 18;
  ctx.fillStyle = CONFIG.colors.player;
  ctx.beginPath();
  ctx.arc(p.x, p.y, CONFIG.playerRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // small pointer showing the aim direction
  const dx = game.mouse.x - p.x;
  const dy = game.mouse.y - p.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  ctx.strokeStyle = CONFIG.colors.player;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(p.x + (dx / len) * CONFIG.playerRadius, p.y + (dy / len) * CONFIG.playerRadius);
  ctx.lineTo(p.x + (dx / len) * (CONFIG.playerRadius + 10), p.y + (dy / len) * (CONFIG.playerRadius + 10));
  ctx.stroke();
}

// --- SPRITE SLOT ---
// To use an image: `ctx.drawImage(enemySprite, enemy.x - r, enemy.y - r, r*2, r*2)`
function drawEnemy(enemy) {
  ctx.save();
  ctx.shadowColor = CONFIG.colors.enemyGlow;
  ctx.shadowBlur = 14;
  ctx.fillStyle = CONFIG.colors.enemy;
  ctx.beginPath();
  ctx.arc(enemy.x, enemy.y, enemy.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(enemy.x, enemy.y, enemy.radius - 4, 0, Math.PI * 2);
  ctx.stroke();
}

// --- SPRITE SLOT ---
// To use an image: `ctx.drawImage(bulletSprite, b.x - r, b.y - r, r*2, r*2)`
function drawBullet(b) {
  ctx.save();
  ctx.shadowColor = CONFIG.colors.bulletGlow;
  ctx.shadowBlur = 20;
  ctx.fillStyle = CONFIG.colors.bullet;
  ctx.beginPath();
  ctx.arc(b.x, b.y, CONFIG.bulletRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// --- SPRITE / TEXTURE SLOT ---
// To use an image or pattern: `ctx.drawImage(wallTexture, wall.x, wall.y, wall.w, wall.h)`
function drawWall(wall) {
  ctx.fillStyle = CONFIG.colors.wall;
  ctx.fillRect(wall.x, wall.y, wall.w, wall.h);
  ctx.strokeStyle = CONFIG.colors.wallBorder;
  ctx.lineWidth = 2;
  ctx.strokeRect(wall.x, wall.y, wall.w, wall.h);
}

function drawParticles() {
  for (const particle of game.particles) {
    const alpha = 1 - particle.age / particle.life;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = particle.color;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawPredictionLine() {
  if (game.bulletFired || game.state !== STATE.PLAYING) return;

  const points = computePredictionPath();
  ctx.save();
  ctx.strokeStyle = CONFIG.colors.prediction;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
  ctx.restore();
}

function render() {
  drawBackground();

  for (const wall of game.walls) drawWall(wall);

  drawPredictionLine();

  for (const enemy of game.enemies) drawEnemy(enemy);

  if (game.player) drawPlayer(game.player);

  if (game.bullet && game.bullet.active) drawBullet(game.bullet);

  drawParticles();
}

/* ======================================================================
   12. UI
   ====================================================================== */

const ui = {
  hud: document.getElementById('hud'),
  hudRoom: document.getElementById('hud-room'),
  hudEnemies: document.getElementById('hud-enemies'),
  hudBullet: document.getElementById('hud-bullet'),
  hudBulletChip: document.getElementById('hud-bullet-chip'),

  screenMenu: document.getElementById('screen-menu'),
  screenDifficulty: document.getElementById('screen-difficulty'),
  screenMode: document.getElementById('screen-mode'),
  screenSettings: document.getElementById('screen-settings'),
  screenControls: document.getElementById('screen-controls'),
  screenHowToPlay: document.getElementById('screen-howtoplay'),
  screenPause: document.getElementById('screen-pause'),
  screenWin: document.getElementById('screen-win'),
  screenLose: document.getElementById('screen-lose'),
  screenFailed: document.getElementById('screen-failed'),
  screenComplete: document.getElementById('screen-complete'),
  screenEndlessOver: document.getElementById('screen-endless-over'),
  screenAccount: document.getElementById('screen-account'),

  hudRunChip: document.getElementById('hud-run-chip'),
  hudRunLabel: document.getElementById('hud-run-label'),
  hudRunTime: document.getElementById('hud-run-time'),
  hudScoreChip: document.getElementById('hud-score-chip'),
  hudScore: document.getElementById('hud-score'),

  endlessOverRoom: document.getElementById('endless-over-room'),
  endlessOverScore: document.getElementById('endless-over-score'),
  endlessOverBestRow: document.getElementById('endless-over-best-row'),
  endlessOverBest: document.getElementById('endless-over-best'),
  btnEndless: document.getElementById('btn-endless'),
  btnEndlessRetry: document.getElementById('btn-endless-retry'),
  btnEndlessMenu: document.getElementById('btn-endless-menu'),

  btnPlay: document.getElementById('btn-play'),
  btnSettings: document.getElementById('btn-settings'),
  btnSettingsBack: document.getElementById('btn-settings-back'),
  btnOpenControls: document.getElementById('btn-open-controls'),
  btnControlsBack: document.getElementById('btn-controls-back'),
  btnControlsReset: document.getElementById('btn-controls-reset'),
  btnOpenHowToPlay: document.getElementById('btn-open-howtoplay'),
  btnHowToPlayBack: document.getElementById('btn-howtoplay-back'),
  btnDiffBack: document.getElementById('btn-diff-back'),
  diffBestEasy: document.getElementById('diff-best-easy'),
  diffBestMedium: document.getElementById('diff-best-medium'),
  diffBestHard: document.getElementById('diff-best-hard'),
  btnModeBack: document.getElementById('btn-mode-back'),
  btnNext: document.getElementById('btn-next'),
  btnRetry: document.getElementById('btn-retry'),

  btnWinRetry: document.getElementById('btn-win-retry'),
  btnWinMenu: document.getElementById('btn-win-menu'),
  btnLoseMenu: document.getElementById('btn-lose-menu'),
  btnFailedRestart: document.getElementById('btn-failed-restart'),
  btnFailedMenu: document.getElementById('btn-failed-menu'),
  btnCompleteRestart: document.getElementById('btn-complete-restart'),
  btnCompleteMenu: document.getElementById('btn-complete-menu'),

  winTitle: document.getElementById('win-title'),
  winRoomTime: document.getElementById('win-room-time'),
  winTotalTime: document.getElementById('win-total-time'),
  winTotalRow: document.getElementById('win-total-row'),
  loseSub: document.getElementById('lose-sub'),
  loseRoomTime: document.getElementById('lose-room-time'),
  failedSub: document.getElementById('failed-sub'),
  failedRoom: document.getElementById('failed-room'),
  failedTime: document.getElementById('failed-time'),
  completeTotalTime: document.getElementById('complete-total-time'),
  completeBestTime: document.getElementById('complete-best-time'),

  btnMenu: document.getElementById('btn-menu'),
  btnResume: document.getElementById('btn-resume'),
  btnRestartLevel: document.getElementById('btn-restart-level'),
  btnRestartRun: document.getElementById('btn-restart-run'),
  btnPauseMenu: document.getElementById('btn-pause-menu'),

  timerDisplay: document.getElementById('timer-display'),
  timerValue: document.getElementById('timer-value')
};

const ALL_SCREENS = [
  ui.screenMenu,
  ui.screenDifficulty,
  ui.screenMode,
  ui.screenSettings,
  ui.screenControls,
  ui.screenHowToPlay,
  ui.screenPause,
  ui.screenWin,
  ui.screenLose,
  ui.screenFailed,
  ui.screenComplete,
  ui.screenEndlessOver,
  ui.screenAccount
];

function showScreen(screen) {
  ALL_SCREENS.forEach((s) => s.classList.add('hidden'));
  if (screen) screen.classList.remove('hidden');
}

function updateHudRoom() {
  ui.hudRoom.textContent = game.endless
    ? `${game.endlessRoom}`
    : `${game.currentLevelIndex + 1} / ${game.levels.length}`;
}

function updateHudScore() {
  ui.hudScore.textContent = game.endlessScore.toLocaleString();
}

function updateHudEnemyCount() {
  ui.hudEnemies.textContent = game.enemies.length;
}

// Live HUD time chip: total run time in normal mode, current room time
// in practice (a "total" across infinite retries would not mean anything).
function updateHudRunTime() {
  const seconds = (game.mode === 'normal' || game.mode === 'endless') ? game.runTime : game.roomTime;
  ui.hudRunTime.textContent = formatTime(seconds);
}

function flashTimerBonus() {
  ui.timerDisplay.classList.remove('bonus');
  // force a reflow so the animation can replay if it was already running
  void ui.timerDisplay.offsetWidth;
  ui.timerDisplay.classList.add('bonus');
  clearTimeout(flashTimerBonus.timeoutId);
  flashTimerBonus.timeoutId = setTimeout(() => {
    ui.timerDisplay.classList.remove('bonus');
  }, 400);
}

function updateHudBulletStatus() {
  if (game.bulletFired) {
    ui.hudBulletChip.classList.add('spent');

    if (game.bullet && game.bullet.active) {
      const remaining = Math.max(0, CONFIG.bulletMaxLifetime - game.bullet.lifetime);
      ui.hudBullet.textContent = 'FIRED';

      ui.timerDisplay.classList.remove('hidden');
      ui.timerValue.textContent = remaining.toFixed(1);
      ui.timerDisplay.classList.toggle('urgent', remaining <= 1.5);
    } else {
      ui.hudBullet.textContent = 'FIRED';
      ui.timerDisplay.classList.add('hidden');
    }
  } else {
    ui.hudBullet.textContent = 'READY';
    ui.hudBulletChip.classList.remove('spent');
    ui.timerDisplay.classList.add('hidden');
    ui.timerDisplay.classList.remove('urgent');
  }
}

/* ---------- Time formatting ---------- */

// 12.34s  /  1:05.20 once it passes a minute
function formatTime(seconds) {
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds - mins * 60;
  return `${mins}:${secs.toFixed(2).padStart(5, '0')}`;
}

/* ---------- Settings / Controls / How to play ---------- */

function goToSettings() {
  game.state = STATE.SETTINGS;
  showScreen(ui.screenSettings);
}

function goToControls() {
  game.state = STATE.CONTROLS;
  renderControlsScreen();
  showScreen(ui.screenControls);
}

function goToHowToPlay() {
  game.state = STATE.HOWTOPLAY;
  showScreen(ui.screenHowToPlay);
}

// Refreshes every rebind button's label to match the current KEYBINDS.
function renderControlsScreen() {
  document.querySelectorAll('.bind-key[data-action]').forEach((btn) => {
    const action = btn.dataset.action;
    btn.textContent = keyDisplayName(KEYBINDS[action]);
    btn.classList.remove('listening');
  });
}

/* ---------- Menu navigation ---------- */

function goToDifficultySelect() {
  game.state = STATE.DIFFICULTY;
  ui.hud.classList.add('hidden');
  renderDifficultyBests();
  showScreen(ui.screenDifficulty);
}

// Difficulty is picked first, then the mode. The run itself only starts
// once both are chosen.
function goToModeSelect(difficulty) {
  game.difficulty = difficulty;
  game.levels = LEVEL_SETS[difficulty];
  game.state = STATE.MODE;
  ui.hud.classList.add('hidden');
  showScreen(ui.screenMode);
}

// Starts a fresh run: room 1 and the clock back to zero. This is the ONLY
// place the run clock is reset, which is what makes a normal run a single
// continuous timed attempt.
function startRun(mode) {
  game.mode = mode;
  game.currentLevelIndex = 0;
  game.runTime = 0;
  game.lastRoomTime = 0;
  ui.completeTotalTime.classList.remove('record');

  // The HUD time chip stays visible in both modes: it tracks the whole
  // run in normal mode, or just the current room while practicing.
  ui.hudRunLabel.textContent = mode === 'normal' ? 'RUN' : 'ROOM';
  ui.winTotalRow.classList.toggle('is-hidden', mode !== 'normal');

  startLevel(game.currentLevelIndex);
}

// Advances from the win screen into the next room (or finishes the run
// if that was the last one). Shared by the NEXT ROOM button and the
// spacebar shortcut.
function goToNextRoom() {
  game.currentLevelIndex++;
  if (game.currentLevelIndex >= game.levels.length) {
    finishRun();
  } else {
    startLevel(game.currentLevelIndex);
  }
}

/* ---------- Retry / restart ---------- */

// Replays the current room WITHOUT touching the run clock - EXCEPT when
// you're retrying room 1: restarting the very first room IS starting the
// run over, so the clock resets to zero in that one case.
function retryLevel() {
  if (game.currentLevelIndex === 0) {
    game.runTime = 0;
  }
  startLevel(game.currentLevelIndex);
}

// Restarts the whole run from room 1 with a fresh clock.
function restartRun() {
  if (game.mode === 'endless') {
    startEndlessRun();
    return;
  }
  startRun(game.mode);
}

/* ---------- Pause menu ---------- */

function pauseGame() {
  if (game.state !== STATE.PLAYING) return;
  // Restarting a single room mid-run would undermine the point of a
  // normal run (clear all 10 rooms with one continuous attempt), so that
  // option only makes sense in practice mode.
  ui.btnRestartLevel.classList.toggle('is-hidden', game.mode === 'normal' || game.mode === 'endless');
  game.state = STATE.PAUSED;
  showScreen(ui.screenPause);
}

function resumeGame() {
  if (game.state !== STATE.PAUSED) return;
  game.state = STATE.PLAYING;
  showScreen(null);
}

function setupUIListeners() {
  ui.btnPlay.addEventListener('click', goToDifficultySelect);
  ui.btnEndless.addEventListener('click', startEndlessRun);

  ui.btnEndlessRetry.addEventListener('click', restartRun);
  ui.btnEndlessMenu.addEventListener('click', returnToMenu);

  ui.btnSettings.addEventListener('click', goToSettings);
  ui.btnSettingsBack.addEventListener('click', () => {
    game.state = STATE.MENU;
    showScreen(ui.screenMenu);
  });

  ui.btnOpenControls.addEventListener('click', goToControls);
  ui.btnControlsBack.addEventListener('click', goToSettings);
  ui.btnControlsReset.addEventListener('click', () => {
    KEYBINDS = { ...DEFAULT_KEYBINDS };
    saveKeybinds();
    renderControlsScreen();
  });

  document.querySelectorAll('.bind-key[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      renderControlsScreen(); // clear any other button left mid-listening
      listeningForAction = btn.dataset.action;
      btn.textContent = 'PRESS A KEY';
      btn.classList.add('listening');
    });
  });

  ui.btnOpenHowToPlay.addEventListener('click', goToHowToPlay);
  ui.btnHowToPlayBack.addEventListener('click', goToSettings);

  ui.btnDiffBack.addEventListener('click', () => {
    game.state = STATE.MENU;
    showScreen(ui.screenMenu);
  });

  document.querySelectorAll('.diff-row[data-difficulty]').forEach((row) => {
    row.addEventListener('click', () => goToModeSelect(row.dataset.difficulty));
  });

  document.querySelectorAll('.mode-card[data-mode]').forEach((card) => {
    card.addEventListener('click', () => startRun(card.dataset.mode));
  });

  ui.btnModeBack.addEventListener('click', goToDifficultySelect);

  ui.btnNext.addEventListener('click', goToNextRoom);

  ui.btnRetry.addEventListener('click', retryLevel);
  ui.btnWinRetry.addEventListener('click', retryLevel);

  ui.btnWinMenu.addEventListener('click', returnToMenu);
  ui.btnLoseMenu.addEventListener('click', returnToMenu);

  // Run failed (normal mode): reset icon starts a brand new run
  ui.btnFailedRestart.addEventListener('click', restartRun);
  ui.btnFailedMenu.addEventListener('click', returnToMenu);

  // Campaign complete: reset icon = run again, house icon = main menu
  ui.btnCompleteRestart.addEventListener('click', restartRun);
  ui.btnCompleteMenu.addEventListener('click', returnToMenu);

  // --- Pause menu wiring ---
  ui.btnMenu.addEventListener('click', pauseGame);
  ui.btnResume.addEventListener('click', resumeGame);

  // Restart only the current room. The in-progress attempt was never
  // banked into runTime, so there is nothing to roll back here.
  ui.btnRestartLevel.addEventListener('click', () => {
    startLevel(game.currentLevelIndex);
  });

  // Restart the whole run, back to room 1 of the current difficulty
  ui.btnRestartRun.addEventListener('click', restartRun);

  // Quit to the main menu
  ui.btnPauseMenu.addEventListener('click', returnToMenu);

  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();

    // A rebind button is waiting for input: this keypress becomes the
    // new binding instead of doing anything else.
    if (listeningForAction) {
      e.preventDefault();
      captureKeybind(listeningForAction, key);
      return;
    }

    // Pause toggles the pause menu
    if (key === KEYBINDS.pause) {
      if (game.state === STATE.PLAYING) pauseGame();
      else if (game.state === STATE.PAUSED) resumeGame();
      return;
    }

    // Next-room key jumps from the win screen straight into the next room
    if (key === KEYBINDS.next) {
      if (game.state === STATE.WIN) {
        e.preventDefault();
        goToNextRoom();
      }
      return;
    }

    // Retry key. In practice mode it just replays the current room. In
    // normal mode there is no "retry one room" option, so it restarts the
    // whole run back to room 1, at any point during that run.
    if (key === KEYBINDS.retry) {
      if (game.mode === 'practice') {
        if (game.state === STATE.PLAYING || game.state === STATE.WIN || game.state === STATE.LOSE) {
          retryLevel();
        }
      } else if (game.mode === 'normal') {
        if (game.state === STATE.PLAYING || game.state === STATE.WIN || game.state === STATE.FAILED) {
          restartRun();
        }
      } else if (game.mode === 'endless') {
        if (game.state === STATE.PLAYING || game.state === STATE.ENDLESS_OVER) {
          restartRun();
        }
      }
    }
  });
}

/* ======================================================================
   13. GAME LOOP / LEVEL MANAGEMENT
   ====================================================================== */

function buildBorderWalls() {
  const b = CONFIG.border;
  const w = CONFIG.canvasWidth;
  const h = CONFIG.canvasHeight;
  return [
    { x: 0, y: 0, w: w, h: b },           // top
    { x: 0, y: h - b, w: w, h: b },       // bottom
    { x: 0, y: 0, w: b, h: h },           // left
    { x: w - b, y: 0, w: b, h: h }        // right
  ];
}

function startLevel(index) {
  const level = game.levels[index];

  game.player = createPlayer(level.player.x, level.player.y);
  game.walls = [...buildBorderWalls(), ...level.walls];
  game.enemies = level.enemies.map((e) => createEnemy(e.x, e.y));
  game.particles = [];
  game.bullet = null;
  game.bulletFired = false;
  game.roomTime = 0; // the room clock restarts on every attempt
  game.timerStarted = false; // waits for the first move or shot before ticking

  game.state = STATE.PLAYING;

  showScreen(null);
  ui.hud.classList.remove('hidden');

  updateHudRoom();
  updateHudEnemyCount();
  updateHudBulletStatus();
  updateHudRunTime();
}

function endRoom(victory) {
  if (game.endless) {
    endEndlessRoom(victory);
    return;
  }

  ui.hud.classList.add('hidden');
  game.lastRoomTime = game.roomTime;

  if (victory) {
    // Clearing the LAST room jumps straight to the final completion
    // screen instead of showing an intermediate "ROOM CLEARED" + NEXT ROOM.
    if (game.currentLevelIndex + 1 >= game.levels.length) {
      finishRun();
      return;
    }

    game.state = STATE.WIN;
    ui.winTitle.textContent = `ROOM ${game.currentLevelIndex + 1} CLEARED`;
    ui.winRoomTime.textContent = formatTime(game.lastRoomTime);
    ui.winTotalTime.textContent = formatTime(game.runTime);
    // Retrying an already-cleared room mid-run would undermine the
    // "one bullet across all 10 rooms" challenge of normal mode.
    ui.btnWinRetry.classList.toggle('is-hidden', game.mode === 'normal');
    showScreen(ui.screenWin);
    return;
  }

  // --- Missed the shot ---
  if (game.mode === 'normal') {
    // A normal run is all-or-nothing: one miss ends the run and sends you
    // back to room 1. The screen reports how far you got and how long.
    game.state = STATE.FAILED;
    const reachedRoom = game.currentLevelIndex + 1;

    // Track "how far you've gotten" on this difficulty, but only while
    // it's still uncompleted - once bestTimes exists the time takes over
    // as the thing that's shown.
    if (game.bestTimes[game.difficulty] === undefined) {
      const previousBestRoom = game.bestProgress[game.difficulty] || 0;
      if (reachedRoom > previousBestRoom) {
        game.bestProgress[game.difficulty] = reachedRoom;
        if (typeof Account !== 'undefined') Account.syncProgress();
      }
    }

    ui.failedSub.textContent = `You missed in room ${reachedRoom} \u00b7 back to the start`;
    ui.failedRoom.textContent = `ROOM ${reachedRoom} / ${game.levels.length}`;
    ui.failedTime.textContent = formatTime(game.runTime);
    showScreen(ui.screenFailed);
  } else {
    // Practice mode: you simply stay on this room and try again.
    game.state = STATE.LOSE;
    ui.loseSub.textContent = `Room ${game.currentLevelIndex + 1} \u00b7 take another shot`;
    ui.loseRoomTime.textContent = formatTime(game.lastRoomTime);
    showScreen(ui.screenLose);
  }
}

// What to show as "your best" for a given difficulty: the completed-run
// time if you've cleared all 10 rooms, otherwise the furthest room
// you've reached, otherwise nothing yet attempted.
function getDifficultyBestLabel(difficulty) {
  if (game.bestTimes[difficulty] !== undefined) {
    return formatTime(game.bestTimes[difficulty]);
  }
  if (game.bestProgress[difficulty]) {
    return `ROOM ${game.bestProgress[difficulty]} / ${LEVEL_SETS[difficulty].length}`;
  }
  return '--';
}

// Refreshes the "best" chip on each row of the difficulty-select screen.
function renderDifficultyBests() {
  if (ui.diffBestEasy) ui.diffBestEasy.textContent = getDifficultyBestLabel('easy');
  if (ui.diffBestMedium) ui.diffBestMedium.textContent = getDifficultyBestLabel('medium');
  if (ui.diffBestHard) ui.diffBestHard.textContent = getDifficultyBestLabel('hard');
}

// Called when the last room of a difficulty has been cleared.
function finishRun() {
  game.state = STATE.COMPLETE;
  ui.hud.classList.add('hidden');

  const total = game.runTime;
  ui.completeTotalTime.textContent = formatTime(total);

  if (game.mode !== 'normal') {
    // Practice runs are not timed attempts, so they never set a record.
    ui.completeBestTime.textContent = 'PRACTICE';
    ui.completeTotalTime.classList.remove('record');
    showScreen(ui.screenComplete);
    return;
  }

  // Personal best per difficulty (in memory, resets when the page reloads)
  const previousBest = game.bestTimes[game.difficulty];
  const isRecord = previousBest === undefined || total < previousBest;

  if (isRecord) {
    game.bestTimes[game.difficulty] = total;
    ui.completeBestTime.textContent = 'NEW RECORD';
    ui.completeTotalTime.classList.add('record');
    if (typeof Account !== 'undefined') Account.syncProgress();
  } else {
    ui.completeBestTime.textContent = formatTime(previousBest);
    ui.completeTotalTime.classList.remove('record');
  }

  showScreen(ui.screenComplete);
}

// Quits to the main menu and fully resets the run: back to room 1 and
// clears the current room, bullet and enemies.
function returnToMenu() {
  game.state = STATE.MENU;
  game.currentLevelIndex = 0;
  game.roomTime = 0;
  game.runTime = 0;
  game.lastRoomTime = 0;
  game.player = null;
  game.bullet = null;
  game.bulletFired = false;
  game.walls = [];
  game.enemies = [];
  game.particles = [];

  game.endless = false;
  game.endlessRoom = 1;
  game.endlessScore = 0;
  game.endlessTransitioning = false;
  clearTimeout(nextEndlessRoomTimer);
  ui.hudScoreChip.classList.add('is-hidden');

  ui.hud.classList.add('hidden');
  ui.timerDisplay.classList.add('hidden');
  ui.timerDisplay.classList.remove('urgent', 'bonus');
  showScreen(ui.screenMenu);
}

function update(dt) {
  if (game.state !== STATE.PLAYING) return;

  // The clock waits for the first real action: a movement key or the shot
  // itself. Time spent just lining up the aim with the mouse is free.
  if (!game.timerStarted) {
    const hasMoved = isMovingUp() || isMovingDown() || isMovingLeft() || isMovingRight();
    if (hasMoved || game.bulletFired) {
      game.timerStarted = true;
    }
  }

  if (game.timerStarted && !game.endlessTransitioning) {
    // Both clocks only advance while actually playing, so pausing is free.
    // runTime is continuous across the whole run: restarting a room does
    // not rewind it, only starting a brand new run does. During the brief
    // endless room-transition pause the clock simply holds still - it
    // resumes the instant the next room starts (see startEndlessRoom).
    game.roomTime += dt;
    game.runTime += dt;
    updateHudRunTime();
  }

  updatePlayer(dt);

  if (game.bulletFired && game.bullet && game.bullet.active) {
    updateBullet(dt);
    updateHudBulletStatus();
  }

  updateParticles(dt);
}

function loop(timestamp) {
  const dt = Math.min(0.033, (timestamp - game.lastTimestamp) / 1000 || 0);
  game.lastTimestamp = timestamp;

  update(dt);
  render();

  requestAnimationFrame(loop);
}

/* ======================================================================
   14. ENDLESS MODE
   ------------------------------------------------------------------
   Self-contained module. Reuses the existing player/bullet/wall/enemy/
   collision/render systems untouched - this section only generates room
   data ({ player, walls, enemies }) and manages the infinite room-to-room
   flow around them.

   RELIABILITY STRATEGY (per design brief):
   Rooms are NOT generated randomly and then checked for solvability with
   an expensive solver. Instead, for every room we:
     1. Pick a random (lightly randomized) wall template.
     2. Pick a random, wall-clear player spawn point.
     3. Simulate ONE bullet trajectory from that spawn, at a random aim
        angle, using the exact same physics functions the real bullet
        uses (circleRectCollision / reflectVelocity / drag / substeps).
     4. Walk that simulated trajectory and drop enemies directly ON it,
        spaced apart and clear of walls.
   Because the enemies are placed exactly where the simulated bullet
   already travels, firing at that same spawn point and angle is
   GUARANTEED to clear the room - there is nothing to search for or
   verify separately. If a candidate room can't fit enough enemies
   (rare, e.g. a cramped template), we just try another random
   combination; after a small, fixed number of attempts we fall back to
   a trivial guaranteed-solvable straight-line room. This can never get
   stuck and never runs more than a handful of simulations.
   ====================================================================== */

const ENDLESS_CONFIG = {
  maxGenerationAttempts: 18,
  minSampleTime: 0.12,      // ignore trajectory points too close to the spawn
  expiryBuffer: 0.25,       // ignore points right before the bullet would expire
  enemyClearance: 26,       // min distance an enemy position must keep from walls
  minEnemyGap: 85,          // min straight-line distance between two enemies
  spawnClearance: 26,       // extra clearance around a candidate spawn point
  spawnAttempts: 12,

  // The room is only guaranteed solvable from ONE exact spot (the "shot
  // origin" the trajectory was simulated from). The player is deliberately
  // NOT placed there - they start a short walk away and have to reposition
  // themselves before the shot lines up. Distance grows with room number.
  playerOffsetAttempts: 24,
  playerOffsetMinBase: 70,     // starting walk distance at room 1
  playerOffsetMinPerRoom: 3,   // grows this much per room...
  playerOffsetMinCap: 210,     // ...up to this cap
  playerOffsetSpread: 150,     // max distance adds this much on top of the min

  roomTransitionMs: 550,

  scoring: {
    perEnemy: 100,
    roomBonusBase: 50,
    roomBonusPerRoom: 15,
    // Floor on the divisor so an implausibly-fast clear (or a 0/near-0
    // edge case) can't blow the score up towards infinity.
    minClearTime: 0.25
  }
};

// Inner-wall generators only - the four border walls are always added on
// top via the existing buildBorderWalls(). Every template returns fresh
// randomized geometry each time it's called.
const ENDLESS_WALL_TEMPLATES = [

  // 0 - open room, no obstacles at all
  () => [],

  // 1 - a single pillar, roughly centered with jitter
  () => {
    const w = 40 + Math.random() * 46;
    const h = 40 + Math.random() * 46;
    const x = 300 + Math.random() * 360;
    const y = 180 + Math.random() * 240;
    return [{ x, y, w, h }];
  },

  // 2 - two pillars, left-ish and right-ish
  () => {
    const mkPillar = (cx) => {
      const w = 36 + Math.random() * 30;
      const h = 36 + Math.random() * 30;
      const cy = 150 + Math.random() * 300;
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    };
    return [mkPillar(300 + Math.random() * 90), mkPillar(600 + Math.random() * 90)];
  },

  // 3 - a vertical corridor wall with a gap, forces routing through it
  () => {
    const b = CONFIG.border;
    const gapY = 180 + Math.random() * 240;
    const gapHeight = 110 + Math.random() * 70;
    const wallX = 400 + Math.random() * 160;
    return [
      { x: wallX, y: b, w: 26, h: gapY - b },
      { x: wallX, y: gapY + gapHeight, w: 26, h: (CONFIG.canvasHeight - b) - (gapY + gapHeight) }
    ];
  },

  // 4 - a horizontal shelf sitting in the upper or lower half
  () => {
    const shelfW = 180 + Math.random() * 160;
    const x = 260 + Math.random() * 260;
    const y = Math.random() < 0.5 ? (130 + Math.random() * 70) : (400 + Math.random() * 70);
    return [{ x, y, w: shelfW, h: 26 }];
  },

  // 5 - a small pillar cluster (only used at higher tiers)
  () => {
    const walls = [];
    const count = 3;
    for (let i = 0; i < count; i++) {
      const w = 34 + Math.random() * 26;
      const h = 34 + Math.random() * 26;
      const x = 260 + i * 220 + Math.random() * 60;
      const y = 150 + Math.random() * 320;
      walls.push({ x, y, w, h });
    }
    return walls;
  }
];

// Difficulty curve: how many enemies, and which wall templates are
// eligible, at a given room number.
function getEndlessDifficulty(roomNumber) {
  if (roomNumber <= 4) {
    // A short, gentle intro - one open room is still possible, but a
    // pillar shows up early too so it isn't pure free-aim from room 1.
    return { minEnemies: 1, maxEnemies: 2, templates: [0, 1, 1] };
  }
  if (roomNumber <= 12) {
    // Open room (template 0) drops out here - every room now needs at
    // least one bounce, which is where the real reading-the-angle skill
    // (and, with the offset spawn above, the walking) comes in.
    return { minEnemies: 2, maxEnemies: 3, templates: [1, 2, 3, 4] };
  }
  if (roomNumber <= 25) {
    return { minEnemies: 3, maxEnemies: 5, templates: [2, 3, 4, 5] };
  }
  // 25+: keep escalating, cap enemy count so it always stays physically
  // placeable on a single trajectory.
  const extraTiers = Math.floor((roomNumber - 25) / 8);
  return {
    minEnemies: 4,
    maxEnemies: Math.min(8, 5 + extraTiers),
    templates: [2, 3, 4, 5]
  };
}

// How far from the guaranteed "shot origin" the player actually spawns.
// Grows (and caps) with room number, so later rooms demand a bit more
// positioning, not just a longer walk without end.
function getEndlessMoveRange(roomNumber) {
  const c = ENDLESS_CONFIG;
  const min = Math.min(c.playerOffsetMinCap, c.playerOffsetMinBase + roomNumber * c.playerOffsetMinPerRoom);
  const max = min + c.playerOffsetSpread;
  return { min, max };
}

// Finds a wall-clear player start point somewhere between minDist and
// maxDist away from `origin` (the exact point the guaranteed trajectory
// was simulated from), and clear of the room's enemies too so the player
// doesn't spawn visually on top of one. Returns null if nothing fits in
// the attempt budget - the caller just falls back to spawning on the
// origin itself.
function pickEndlessPlayerStart(origin, walls, minDist, maxDist, enemies) {
  const margin = CONFIG.border + CONFIG.playerRadius + 20;
  for (let i = 0; i < ENDLESS_CONFIG.playerOffsetAttempts; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = minDist + Math.random() * (maxDist - minDist);
    const x = origin.x + Math.cos(angle) * dist;
    const y = origin.y + Math.sin(angle) * dist;
    if (x < margin || x > CONFIG.canvasWidth - margin || y < margin || y > CONFIG.canvasHeight - margin) continue;

    let ok = true;
    for (const wall of walls) {
      if (circleRectCollision(x, y, CONFIG.playerRadius + ENDLESS_CONFIG.spawnClearance, wall).colliding) {
        ok = false;
        break;
      }
    }
    if (ok && enemies) {
      for (const enemy of enemies) {
        const dx = x - enemy.x;
        const dy = y - enemy.y;
        if (Math.sqrt(dx * dx + dy * dy) < CONFIG.playerRadius + 16 + 20) { ok = false; break; }
      }
    }
    if (ok) return { x, y };
  }
  return null;
}

// Base score for the room, then divided by how long the room took to clear
// (in seconds) so faster clears are worth more - e.g. a 300-point room
// cleared in 3s scores 100. Floored to a whole number, and the divisor is
// clamped so a near-instant clear can't send the score to infinity.
function endlessRoomScore(roomNumber, enemyCount, clearTimeSeconds) {
  const s = ENDLESS_CONFIG.scoring;
  const base = enemyCount * s.perEnemy + s.roomBonusBase + roomNumber * s.roomBonusPerRoom;
  const divisor = Math.max(clearTimeSeconds, s.minClearTime);
  return Math.floor(base / divisor);
}

// Simulates a full bullet flight from (startX, startY) at `angle`, against
// `walls`, using the SAME drag/substep/collision logic as the real
// updateBullet() - just without enemies, since none exist yet. Returns an
// array of { x, y, t } points sampled at every physics substep.
function simulateBulletTrace(startX, startY, angle, walls) {
  const dt = 1 / 60; // one virtual frame, matching the game's typical frame time
  let x = startX;
  let y = startY;
  let vx = Math.cos(angle) * CONFIG.bulletSpeed;
  let vy = Math.sin(angle) * CONFIG.bulletSpeed;
  let lifetime = 0;

  const points = [{ x, y, t: 0 }];
  const maxFrames = Math.ceil(CONFIG.bulletMaxLifetime / dt) + 5;

  for (let frame = 0; frame < maxFrames; frame++) {
    lifetime += dt;

    const speed = Math.sqrt(vx * vx + vy * vy);
    const newSpeed = Math.max(0, speed * (1 - CONFIG.bulletDrag * dt));
    if (speed > 0) {
      vx = (vx / speed) * newSpeed;
      vy = (vy / speed) * newSpeed;
    }

    const totalDist = newSpeed * dt;
    const steps = Math.max(1, Math.ceil(totalDist / CONFIG.bulletSubstepSize));
    const stepDx = (vx * dt) / steps;
    const stepDy = (vy * dt) / steps;

    for (let i = 0; i < steps; i++) {
      x += stepDx;
      y += stepDy;

      for (const wall of walls) {
        const res = circleRectCollision(x, y, CONFIG.bulletRadius, wall);
        if (res.colliding) {
          x += res.pushX;
          y += res.pushY;
          const reflected = reflectVelocity(vx, vy, res.normalX, res.normalY);
          vx = reflected.vx;
          vy = reflected.vy;
        }
      }

      points.push({ x, y, t: lifetime });
    }

    if (newSpeed <= CONFIG.bulletMinSpeed || lifetime >= CONFIG.bulletMaxLifetime) break;
  }

  return points;
}

// Walks a simulated trajectory and greedily picks `desiredCount` points
// that are clear of every wall and well spaced from each other. Returns
// null if the trajectory can't fit that many - the caller just tries a
// different random room instead of searching harder.
function pickEnemyPointsFromTrace(points, desiredCount, walls) {
  const clearance = 16 + ENDLESS_CONFIG.enemyClearance; // enemy radius + margin
  const chosen = [];

  for (const p of points) {
    if (chosen.length >= desiredCount) break;
    if (p.t < ENDLESS_CONFIG.minSampleTime) continue;
    if (p.t > CONFIG.bulletMaxLifetime - ENDLESS_CONFIG.expiryBuffer) continue;

    let clear = true;
    for (const wall of walls) {
      if (circleRectCollision(p.x, p.y, clearance, wall).colliding) { clear = false; break; }
    }
    if (!clear) continue;

    let farEnough = true;
    for (const c of chosen) {
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      if (Math.sqrt(dx * dx + dy * dy) < ENDLESS_CONFIG.minEnemyGap) { farEnough = false; break; }
    }
    if (!farEnough) continue;

    chosen.push(p);
  }

  return chosen.length === desiredCount ? chosen : null;
}

// Finds a random player spawn point that doesn't collide with any wall.
function pickEndlessSpawn(walls) {
  const margin = CONFIG.border + CONFIG.playerRadius + 20;
  for (let i = 0; i < ENDLESS_CONFIG.spawnAttempts; i++) {
    const x = margin + Math.random() * (CONFIG.canvasWidth - margin * 2);
    const y = margin + Math.random() * (CONFIG.canvasHeight - margin * 2);

    let ok = true;
    for (const wall of walls) {
      if (circleRectCollision(x, y, CONFIG.playerRadius + ENDLESS_CONFIG.spawnClearance, wall).colliding) {
        ok = false;
        break;
      }
    }
    if (ok) return { x, y };
  }
  return null;
}

// Guaranteed-solvable fallback used if generation somehow can't find a fit
// within the attempt budget (extremely rare) - a plain straight shot.
function generateEndlessFallbackRoom(desiredCount, roomNumber) {
  const count = Math.max(1, Math.min(desiredCount, 4));
  const enemies = [];
  const spacing = 700 / (count + 1);
  for (let i = 1; i <= count; i++) {
    enemies.push({ x: 140 + spacing * i, y: 300 });
  }
  const shotOrigin = { x: 90, y: 300 };
  const range = getEndlessMoveRange(roomNumber);
  const playerStart = pickEndlessPlayerStart(shotOrigin, [], range.min, range.max, enemies) || shotOrigin;
  return { player: playerStart, shotOrigin, walls: [], enemies };
}

function generateEndlessRoom(roomNumber) {
  const diff = getEndlessDifficulty(roomNumber);
  const desiredCount = diff.minEnemies + Math.floor(Math.random() * (diff.maxEnemies - diff.minEnemies + 1));

  for (let attempt = 0; attempt < ENDLESS_CONFIG.maxGenerationAttempts; attempt++) {
    const templateIndex = diff.templates[Math.floor(Math.random() * diff.templates.length)];
    const innerWalls = ENDLESS_WALL_TEMPLATES[templateIndex]();
    const allWalls = [...buildBorderWalls(), ...innerWalls];

    // shotOrigin is the ONE spot the guaranteed trajectory below is valid
    // from. The player does not start there - see pickEndlessPlayerStart -
    // so lining up the shot takes an actual walk, not just a mouse move.
    const shotOrigin = pickEndlessSpawn(allWalls);
    if (!shotOrigin) continue;

    const angle = Math.random() * Math.PI * 2;
    const trace = simulateBulletTrace(shotOrigin.x, shotOrigin.y, angle, allWalls);
    const enemyPoints = pickEnemyPointsFromTrace(trace, desiredCount, allWalls);
    if (!enemyPoints) continue;

    const range = getEndlessMoveRange(roomNumber);
    const playerStart = pickEndlessPlayerStart(shotOrigin, allWalls, range.min, range.max, enemyPoints) || shotOrigin;

    return {
      player: { x: playerStart.x, y: playerStart.y },
      shotOrigin: { x: shotOrigin.x, y: shotOrigin.y },
      walls: innerWalls,
      enemies: enemyPoints.map((p) => ({ x: p.x, y: p.y }))
    };
  }

  return generateEndlessFallbackRoom(desiredCount, roomNumber);
}

/* ---------- Endless run / room lifecycle ---------- */

let nextEndlessRoomTimer = null;

function startEndlessRun() {
  game.mode = 'endless';
  game.endless = true;
  game.endlessRoom = 1;
  game.endlessScore = 0;
  game.runTime = 0;
  game.lastRoomTime = 0;
  game.endlessTransitioning = false;
  clearTimeout(nextEndlessRoomTimer);

  ui.hudRunLabel.textContent = 'TIME';
  ui.hudScoreChip.classList.remove('is-hidden');
  updateHudScore();

  startEndlessRoom(game.endlessRoom);
}

function startEndlessRoom(roomNumber) {
  const room = generateEndlessRoom(roomNumber);

  game.player = createPlayer(room.player.x, room.player.y);
  game.walls = [...buildBorderWalls(), ...room.walls];
  game.enemies = room.enemies.map((e) => createEnemy(e.x, e.y));
  game.endlessRoomEnemyCount = game.enemies.length;
  game.particles = [];
  game.bullet = null;
  game.bulletFired = false;
  game.roomTime = 0;
  game.timerStarted = false;

  // A new room is live: the clock resumes ticking from here.
  game.endlessTransitioning = false;

  game.state = STATE.PLAYING;

  showScreen(null);
  ui.hud.classList.remove('hidden');

  updateHudRoom();
  updateHudEnemyCount();
  updateHudBulletStatus();
  updateHudRunTime();
  updateHudScore();
}

// Called from endRoom() whenever game.endless is true.
function endEndlessRoom(victory) {
  game.lastRoomTime = game.roomTime;

  if (victory) {
    // The bullet cleared the room but is still "active" mid-flight; stop
    // processing it now so it can't keep flying, decay, and wrongly
    // trigger a miss (endRoom(false)) while we sit in this brief gap.
    game.bulletFired = false;
    if (game.bullet) game.bullet.active = false;
    updateHudBulletStatus();

    game.endlessScore += endlessRoomScore(game.endlessRoom, game.endlessRoomEnemyCount, game.lastRoomTime);
    updateHudScore();
    game.endlessRoom++;

    // Brief pause so the last kill reads before the next room appears. The
    // clock (and enemy count) just holds still through this pause - it
    // resumes the instant the next room spawns.
    game.endlessTransitioning = true;
    clearTimeout(nextEndlessRoomTimer);
    nextEndlessRoomTimer = setTimeout(() => {
      if (!game.endless) return; // the player backed out to the menu meanwhile
      startEndlessRoom(game.endlessRoom);
    }, ENDLESS_CONFIG.roomTransitionMs);
    return;
  }

  // Missed the shot - the run ends here.
  game.state = STATE.ENDLESS_OVER;
  ui.hud.classList.add('hidden');

  const reachedRoom = game.endlessRoom;
  const isNewBestRoom = game.endlessBest.room === null || reachedRoom > game.endlessBest.room;
  const isNewBestScore = game.endlessBest.score === null || game.endlessScore > game.endlessBest.score;
  const isNewBestTime = game.endlessBest.time === null || game.runTime > game.endlessBest.time;
  if (isNewBestRoom) game.endlessBest.room = reachedRoom;
  if (isNewBestScore) game.endlessBest.score = game.endlessScore;
  if (isNewBestTime) game.endlessBest.time = game.runTime;
  if ((isNewBestRoom || isNewBestScore || isNewBestTime) && typeof Account !== 'undefined') Account.syncProgress();

  ui.endlessOverRoom.textContent = `${reachedRoom}`;
  ui.endlessOverScore.textContent = game.endlessScore.toLocaleString();
  if (game.endlessBest.room !== null) {
    ui.endlessOverBest.textContent = `ROOM ${game.endlessBest.room} \u00b7 ${game.endlessBest.score.toLocaleString()}`;
  } else {
    ui.endlessOverBest.textContent = '--';
  }

  showScreen(ui.screenEndlessOver);
}

/* ======================================================================
   INIT
   ====================================================================== */

function init() {
  game.levels = MEDIUM_LEVELS; // default until a difficulty is picked

  loadKeybinds();
  setupInput();
  setupUIListeners();
  showScreen(ui.screenMenu);
  requestAnimationFrame(loop);

  // Account.init() also wires up the account screen (login/signup/logout)
  // and, once it resolves, merges any saved best times / endless best into
  // `game` - either from Supabase (logged in) or localStorage (guest).
  if (typeof Account !== 'undefined') {
    Account.init().then(() => {
      updateHudScore();
    });
  }
}

init();