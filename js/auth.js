/**
 * ============================================================
 *  AUTH MODULE (Supabase)
 *  auth.js
 * ============================================================
 */
'use strict';

const Auth = (() => {
  let currentUser = null;
  let currentUserDoc = null;
  let authListenerObj = null;

  async function getUserDoc(uid) {
    try {
      const { data, error } = await supabase.from('users').select('*').eq('uid', uid).single();
      if (error) throw error;
      return data;
    } catch (e) {
      return null;
    }
  }

  return {
    /**
     * Start listening to auth state changes
     * callback(supabaseUser, userDoc)
     */
    async onAuthStateChanged(callback) {
      // First check initial session
      const { data: { session } } = await supabase.auth.getSession();
      
      const notify = async (session) => {
        if (session?.user) {
          currentUser = { ...session.user, photoURL: session.user.user_metadata?.avatar_url };
          // Refresh user doc from our own users table
          const rawDoc = await getUserDoc(session.user.id);
          if (rawDoc) {
            currentUserDoc = {
              ...rawDoc,
              displayName: rawDoc.display_name,
              photoURL: rawDoc.photo_url
            };
          } else {
            currentUserDoc = null;
          }
          callback(currentUser, currentUserDoc);
        } else {
          currentUser = null;
          currentUserDoc = null;
          callback(null, null);
        }
      };

      await notify(session);

      // Subscribe to changes
      authListenerObj = supabase.auth.onAuthStateChange(async (event, session) => {
        if (event !== 'INITIAL_SESSION' && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'SIGNED_OUT')) {
          await notify(session);
        }
      });
    },

    async signInWithGoogle() {
      // Note: In Supabase, signInWithOAuth redirects the page by default.
      // After successful login, it redirects back to the site.
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          queryParams: {
            access_type: 'offline',
            prompt: 'select_account consent',
          }
        }
      });
      if (error) throw error;
      return data;
    },

    async signOut() {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      currentUser = null;
      currentUserDoc = null;
      // Only remove Supabase auth keys — preserve user preferences (e.g. theme)
      Object.keys(localStorage)
        .filter(k => k.startsWith('sb-') || k.startsWith('supabase.'))
        .forEach(k => localStorage.removeItem(k));
      sessionStorage.clear();
    },

    get user() { return currentUser; },
    get userDoc() { return currentUserDoc; }
  };
})();

window.Auth = Auth;
