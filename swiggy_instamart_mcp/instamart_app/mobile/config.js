// Only the backend URL is compiled into the APK now. The user's personal
// token is NOT here -- each person pastes their own on first launch, and it
// goes into the device keychain via expo-secure-store.
//
// This is the difference between "anyone who decompiles the APK gets a working
// credential" and "they get a URL". Keep it that way.
export const BASE_URL = "https://your-backend.example.com";
