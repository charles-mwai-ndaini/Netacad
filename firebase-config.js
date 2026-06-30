/* ═══════════════════════════════════════════════════════════════
   FIREBASE CONFIGURATION
   firebase-config.js

   1. Go to https://console.firebase.google.com
   2. Create a project (or open an existing one).
   3. Click the "</>" (Web app) icon to register a web app.
   4. Firebase will show you a config object — copy YOUR values into
      the object below, replacing the placeholder strings.
   5. In the left menu, open "Build > Authentication > Sign-in method"
      and enable "Email/Password".
   6. In the left menu, open "Build > Firestore Database" and click
      "Create database" (start in production mode — we provide
      security rules separately, see firestore.rules.txt).
═══════════════════════════════════════════════════════════════ */

const firebaseConfig = {
  apiKey: "AIzaSyBiexzZHGvTMhl7qN-BK9ZyW8iqKhUhRYI",
  authDomain: "project-afc36.firebaseapp.com",
  projectId: "project-afc36",
  storageBucket: "project-afc36.firebasestorage.app",
  messagingSenderId: "194992072596",
  appId: "1:194992072596:web:c52504a05e5fdd80975181"
};

// Initialize Firebase (uses the compat libraries loaded in index.html,
// so this stays plain script-tag JavaScript — no build tools, no imports).
firebase.initializeApp(firebaseConfig);

// Expose the two services the rest of script.js will use everywhere.
const auth = firebase.auth();
const db   = firebase.firestore();

// Optional: improves reliability on flaky connections (queues writes
// while offline and syncs automatically when back online). This is
// allowed local caching — Firestore remains the permanent source of
// truth, this just smooths over brief network drops.
db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  console.warn("Firestore offline persistence not enabled:", err.code);
});
