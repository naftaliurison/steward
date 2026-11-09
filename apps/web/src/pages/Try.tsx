import { demoApi } from "../demo/api";
import { Emulator } from "../demo/Emulator";
import type { Store } from "../demo/useDemoSession";

/** sessionStorage, tolerant of browsers that refuse it: the session then just does not survive a reload. */
const browserStore: Store = {
  get: (key) => {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // storage refused: nothing to do
    }
  },
  remove: (key) => {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // storage refused: nothing to do
    }
  },
};

const api = demoApi((path, init) => fetch(path, init));
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function Try() {
  return <Emulator api={api} store={browserStore} tz={tz} />;
}
