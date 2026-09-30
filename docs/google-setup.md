# Google Drive setup

Reader works offline without Google. Sync needs one Google Cloud project with two OAuth clients: one for desktop and one for Android. Only the `drive.file` scope is requested, so Reader can see only the files it created.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (e.g. "Reader") and enable the **Google Drive API**.
2. In **Google Auth Platform**, set the branding to Reader and the audience to **External**. While the app is in Testing, add your account as a test user. Under Data Access, add only `https://www.googleapis.com/auth/drive.file`.
3. **Desktop client:** under Clients, create an OAuth client of type **Desktop app** and download its JSON. Then either:
   - copy it to `~/Library/Application Support/org.reader.books/google-client.json`, or
   - point `READER_GOOGLE_CLIENT_JSON=/absolute/path.json` at it when you run `pnpm desktop`, or
   - bake it into a release build: `READER_GOOGLE_CLIENT_ID=… READER_GOOGLE_CLIENT_SECRET=… pnpm build:desktop`.

   Never commit the JSON (`google-client.json` is gitignored). Desktop "secrets" are public identifiers under Google's installed-app model. The refresh token is stored in the macOS keychain (`org.reader.books.google`).
4. **Android client:** create an OAuth client of type **Android** with package name `org.reader.books` and the SHA-1 of the certificate that signs the APK:

   ```sh
   keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android | grep SHA1
   ```

   Register the debug certificate for development and your release keystore for release builds. No file goes into the app, because Play services matches the client by package and certificate. If they don't match, Reader shows "Google sign-in isn't set up for this Android build".
5. Both clients must be in the **same project**. Otherwise each client only sees its own `drive.file` files and the devices never find each other's checkpoints.

In Testing mode, Google refresh tokens expire after 7 days. Reader will ask you to reconnect. Publishing the consent screen removes that limit, and `drive.file` doesn't need verification.
