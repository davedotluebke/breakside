// CloudFront Function (viewer-request) for the two short links the static
// origins have no route for:
//
//   /view/<hash>  -> /?share=<hash>                  (share links)
//   /join/<code>  -> /landing/join.html?code=<code>  (invite links)
//
// Without this, S3's 404 fallback answers /view/<hash> with the app's
// index.html, whose inline head shim performs the same redirect — but by
// then the browser's preload scanner has already requested every relative
// asset under /view/, and each of those 404s comes back as the whole page.
// Answering at the edge means none of that traffic happens. The shim stays
// in index.html as the fallback for dev servers and any origin without this
// function; tests/unit/shortLinkShim.test.mjs pins it.
//
// Any other query on the incoming URL survives (a dev ?api= override).
// Runtime: cloudfront-js-2.0. Deploy steps: breakside-ops runbooks.
function handler(event) {
  var req = event.request;
  var view = req.uri.match(/^\/view\/([A-Za-z0-9]+)\/?$/);
  var join = req.uri.match(/^\/join\/([A-Za-z0-9]+)\/?$/);
  if (!view && !join) return req;

  var parts = [];
  for (var k in req.querystring) {
    if (k === 'share' || k === 'code') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(req.querystring[k].value));
  }
  var target;
  if (view) {
    parts.push('share=' + view[1]);
    target = '/?' + parts.join('&');
  } else {
    parts.push('code=' + join[1]);
    target = '/landing/join.html?' + parts.join('&');
  }
  return {
    statusCode: 302,
    statusDescription: 'Found',
    headers: {
      location: { value: target },
      'cache-control': { value: 'no-store' }
    }
  };
}
