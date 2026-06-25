// @vitest-environment happy-dom
/**
 * Tests for composer-prefs — TODO-3 UI #2 / #4.J.
 *
 * Covers the localStorage-backed composer command-style preference
 * helpers: defaults, persistence, validation, cross-tab sync via the
 * 'storage' event, and same-tab sync via the custom
 * 'mathran:commandStyle' event.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEFAULT_COMMAND_STYLE,
  loadCommandStyle,
  saveCommandStyle,
  subscribeCommandStyle,
  type CommandStyle,
} from "./composer-prefs";

const KEY = "mathran.composer.commandStyle";

describe("composer-prefs", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe("loadCommandStyle", () => {
    it("returns the default when nothing is stored", () => {
      expect(loadCommandStyle()).toBe(DEFAULT_COMMAND_STYLE);
      expect(DEFAULT_COMMAND_STYLE).toBe("selector");
    });

    it("returns 'slash' when stored", () => {
      window.localStorage.setItem(KEY, "slash");
      expect(loadCommandStyle()).toBe("slash");
    });

    it("returns 'selector' when stored", () => {
      window.localStorage.setItem(KEY, "selector");
      expect(loadCommandStyle()).toBe("selector");
    });

    it("falls back to default on invalid stored values", () => {
      window.localStorage.setItem(KEY, "garbage");
      expect(loadCommandStyle()).toBe(DEFAULT_COMMAND_STYLE);
      window.localStorage.setItem(KEY, "");
      expect(loadCommandStyle()).toBe(DEFAULT_COMMAND_STYLE);
    });
  });

  describe("saveCommandStyle", () => {
    it("persists the value to localStorage", () => {
      saveCommandStyle("slash");
      expect(window.localStorage.getItem(KEY)).toBe("slash");
      saveCommandStyle("selector");
      expect(window.localStorage.getItem(KEY)).toBe("selector");
    });

    it("dispatches a custom event so same-tab subscribers react", () => {
      const handler = vi.fn();
      window.addEventListener("mathran:commandStyle", handler);
      saveCommandStyle("slash");
      expect(handler).toHaveBeenCalledOnce();
      const ev = handler.mock.calls[0][0] as CustomEvent<CommandStyle>;
      expect(ev.detail).toBe("slash");
      window.removeEventListener("mathran:commandStyle", handler);
    });
  });

  describe("subscribeCommandStyle", () => {
    it("invokes the callback when saveCommandStyle fires in the same tab", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeCommandStyle(cb);
      saveCommandStyle("slash");
      expect(cb).toHaveBeenCalledWith("slash");
      saveCommandStyle("selector");
      expect(cb).toHaveBeenCalledWith("selector");
      expect(cb).toHaveBeenCalledTimes(2);
      unsubscribe();
    });

    it("invokes the callback on cross-tab storage events", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeCommandStyle(cb);
      // Simulate another tab writing to localStorage.
      const storageEv = new StorageEvent("storage", {
        key: KEY,
        newValue: "slash",
        oldValue: null,
        storageArea: window.localStorage,
      });
      window.dispatchEvent(storageEv);
      expect(cb).toHaveBeenCalledWith("slash");
      unsubscribe();
    });

    it("ignores storage events for unrelated keys", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeCommandStyle(cb);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "unrelated",
          newValue: "slash",
          storageArea: window.localStorage,
        }),
      );
      expect(cb).not.toHaveBeenCalled();
      unsubscribe();
    });

    it("ignores invalid newValue on storage events", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeCommandStyle(cb);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: KEY,
          newValue: "garbage",
          storageArea: window.localStorage,
        }),
      );
      expect(cb).not.toHaveBeenCalled();
      unsubscribe();
    });

    it("stops invoking the callback after unsubscribe", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeCommandStyle(cb);
      unsubscribe();
      saveCommandStyle("slash");
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
