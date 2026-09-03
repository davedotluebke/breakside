function handler(event) {
  var r = event.response;
  // Report-only CSP: logs violations to the browser console, blocks nothing.
  // The four safe headers come from the managed response-headers policy;
  // this only adds what the Free pricing plan will not let a custom policy add.
  r.headers['content-security-policy-report-only'] = { value: "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; frame-src 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; img-src 'self' data:; media-src 'self'; connect-src 'self' https://api.breakside.pro https://mfuziqztsfqaqnnxjcrr.supabase.co wss://api.openai.com; worker-src 'self'; manifest-src 'self'" };
  return r;
}
