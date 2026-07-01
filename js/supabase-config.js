/**
 * ============================================================
 *  SUPABASE CONFIGURATION
 *  Face Attendance System — Production Config
 * ============================================================
 *
 *  HOW TO GET YOUR CONFIG:
 *  1. Go to https://supabase.com and sign in (or create a free account).
 *  2. Click "New Project", give it a name and password, select a region, click "Create new project".
 *  3. Once created, go to Project Settings (gear icon bottom left) -> API.
 *  4. Copy the "Project URL" and the "anon" "public" key below.
 *
 *  HOW TO ENABLE GOOGLE LOGIN:
 *  1. In Supabase, go to Authentication -> Providers -> Google.
 *  2. Enable it. (You will need to configure a Google Cloud OAuth Client ID, 
 *     Supabase provides a direct link/tutorial right there on how to do it).
 * ============================================================
 */

const SUPABASE_URL = "https://iefnmrahnrxxjwnzozkg.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImllZm5tcmFobnJ4eGp3bnpvemtnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NDI3NjMsImV4cCI6MjA5ODQxODc2M30.ngnsJJLpyFwP5XF8UlE112Tpr5nQgzPBqAPIY4fVZXo";

/** ── App-level settings ─────────────────────────────────── */
const APP_CONFIG = {
  /** Name shown in the UI header */
  institutionName: "Minhaj University Lahore",

  /**
   * Restrict login to a specific email domain.
   * Set to null to allow ANY Google account.
   * Example: "@university.edu" → only university emails allowed.
   */
  allowedEmailDomain: null,

  /** Face match euclidean-distance threshold (lower = stricter) */
  defaultFaceThreshold: 0.45,

  /** Milliseconds between auto-scan cycles during attendance */
  autoScanInterval: 1500,

  /** Minimum face confidence score from detector (0–1) */
  detectorScoreThreshold: 0.55,

  /** Cooldown in ms after a successful attendance mark */
  markCooldownMs: 5000
};

// ── Initialize Supabase ───────────────────────────────────────
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.supabase = supabaseClient;

console.log('[Supabase] Client initialized ✓');
