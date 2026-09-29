/**
 * Phone profiles for the viewport sweep (viewport-sweep.spec.ts).
 *
 * `viewport` is the CSS-pixel area the page actually gets, which is smaller
 * than the screen: Safari's toolbars, Chrome's URL bar and the status bar all
 * come out of it. The in-game screen is a fixed, non-scrolling shell, so the
 * browser toolbars never collapse during a game; the "toolbars showing" size
 * is the one a coach lives with. An installed Home Screen app loses only the
 * status bar (index.html has no viewport-fit=cover, so the page starts below
 * it).
 *
 * Browser numbers match Playwright's own device descriptors where one exists
 * (`devices['iPhone 13 Mini']` is 375x629, `devices['iPhone 15 Pro Max']` is
 * 430x739). To add a coach's phone: find its CSS screen size (screen pixels
 * divided by device pixel ratio), subtract the browser chrome as below, and
 * append an entry. Order is the column order of the contact sheet.
 *
 * These are emulated in Chromium. Layout is close to Safari's but not
 * identical, so a finding that only one engine could produce still wants a
 * look on a real iPhone.
 */

export type Phone = {
  /** Short id, used in file names. */
  id: string;
  /** Column heading on the contact sheet. */
  label: string;
  viewport: { width: number; height: number };
  /** The phone's real pixel ratio, recorded for reference only. */
  dpr: number;
  ios: boolean;
  note: string;
};

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; IN2013) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

export function userAgentFor(phone: Phone) {
  return phone.ios ? IOS_UA : ANDROID_UA;
}

export const PHONES: Phone[] = [
  {
    id: 'pro-max-home',
    label: 'iPhone 15 Pro Max · Home Screen',
    viewport: { width: 430, height: 873 },
    dpr: 3,
    ios: true,
    note: 'Baseline. 430x932 screen minus the 59pt Dynamic Island status bar.',
  },
  {
    id: 'oneplus-8',
    label: 'OnePlus 8 · Chrome',
    viewport: { width: 412, height: 839 },
    dpr: 2.625,
    ios: false,
    note: '1080x2400 at 2.625 = 412x915, the same panel as the Pixel 7; ' +
      'Playwright\'s Pixel 7 profile puts Chrome\'s visible area at 412x839. ' +
      'A larger "Display size" setting narrows this (Large is about 360 wide).',
  },
  {
    id: 'galaxy-s24',
    label: 'Galaxy S24 · Chrome',
    viewport: { width: 360, height: 780 },
    dpr: 3,
    ios: false,
    note: 'Width floor: 360 CSS px is the default width of most current Samsung phones.',
  },
  {
    id: 'mini-home',
    label: 'iPhone 13 mini · Home Screen',
    viewport: { width: 375, height: 762 },
    dpr: 3,
    ios: true,
    note: '375x812 screen minus the 50pt status bar.',
  },
  {
    id: 'mini-safari',
    label: 'iPhone 13 mini · Safari',
    viewport: { width: 375, height: 629 },
    dpr: 3,
    ios: true,
    note: 'Playwright\'s iPhone 13 Mini profile: Safari with its bottom toolbar showing.',
  },
  {
    id: 'se-safari',
    label: 'iPhone SE · Safari',
    viewport: { width: 375, height: 548 },
    dpr: 2,
    ios: true,
    note: 'Height floor: 375x667 screen minus the status bar and Safari\'s toolbars. ' +
      'Not a known coach phone; here to show how gracefully layouts degrade.',
  },
];
