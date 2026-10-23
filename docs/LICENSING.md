# Licensing and attribution

The original author confirmed ownership and explicitly selected MIT for IntelBoard Desktop. The root LICENSE applies to original IntelBoard code and new desktop code. The code-native four-square icon derives from the interface brand mark; no reference binary icon, personal image, document or uploaded file was copied.

`npm run notices` walks installed production dependencies and includes their available license/notice texts. Run it separately on each packaging platform because optional native packages differ. Retain the resulting THIRD_PARTY_NOTICES.txt in installers. Electron's MIT license and Chromium's LICENSES.chromium.html ship beside the executable. Keep them in place.

Principal components include React/React DOM, React Flow, Lucide, EPUB.js, JSZip, yauzl, DOMPurify, Zod, Cheerio, ipaddr.js, PDF.js and Sharp. These have their own notices; their licenses are not replaced by the root MIT license. PDF.js is Apache-2.0; JSZip permits its MIT option; Lucide includes ISC/MIT icon notices. The exact installed versions and full terms are in the generated notice file and package lock.

Sharp is Apache-2.0 and dynamically loads libvips and other native libraries. The prebuilt libvips packages include LGPL components and third-party notices; the generated notice includes the native-package attribution tables and GPL/LGPL texts. Retain those files and the native library packages outside ASAR so users can replace compatible libraries. Corresponding upstream source is available through the Sharp/libvips build project and each named component's upstream releases; see the packaged versions.json for exact versions. Before public binary distribution, verify that all required corresponding source and notices for the exact platform build remain available and satisfy the libraries' licenses. This dependency review is not a substitute for legal advice.

Generated notices are reproducible convenience output, not a grant of rights to unrelated user-imported material. Users remain responsible for the documents/media they import and share.
