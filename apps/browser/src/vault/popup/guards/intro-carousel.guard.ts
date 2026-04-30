// AZCO: skip the 4-slide welcome carousel for first-time users. The extension
// is force-installed by GPO and users are pre-provisioned, so the carousel
// adds friction without adding value -- they want the login form, not a
// product tour. Returning true unconditionally short-circuits the guard.
export const IntroCarouselGuard = async () => true;
