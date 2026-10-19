// ScanMyFood web: connection settings.
// Your backend teammate only needs to edit this file (see README.md, "Connecting the backend").
window.SMF_CONFIG = {
  // Base URL of the Spring Boot server. The browser must be allowed by CORS on that server.
  apiBase: 'http://localhost:8080/api',

  // Paths are appended to apiBase. Replace each one with the real controller path.
  // Set a path to '' to switch that feature off and use local data only.
  endpoints: {
    analyze: '/food/analyze',   // POST multipart: image file + mode ("meal" or "label"). Returns the analysis JSON.
    chat: '/food/chat',         // POST JSON { question, food, diet, calorieGoal }. Returns { answer } or { reply }.
    suggest: '/food/suggest',   // POST JSON { ingredients, diet, kitchen, calorieGoal }. Returns meal ideas.
    profile: '/profile',        // PUT JSON profile. GET returns the saved profile.
    meals: '/meals',            // GET list, POST one meal, DELETE /meals/{id}.
  },

  // Name of the multipart field that carries the photo (Spring: @RequestParam("image")).
  imageField: 'image',

  requestTimeoutMs: 25000,

  // Firebase web app config (Firebase console > Project settings > Your apps > Web app).
  // Leave null to run in guest mode. The sign-in buttons appear once this is filled in.
  //   { apiKey: '...', authDomain: '...', projectId: '...', appId: '...' }
  firebase: null,
};
