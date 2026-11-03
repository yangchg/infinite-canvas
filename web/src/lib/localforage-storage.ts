import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

localforage.config({
    name: `infinite-canvas:${sessionStorage.getItem("canvas-account") || "signed-out"}`,
    storeName: "app_state",
});

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            return (await localforage.getItem<string>(name)) || null;
        } catch {
            return window.localStorage.getItem(`${sessionStorage.getItem("canvas-account")}:${name}`);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
        } catch {
            window.localStorage.setItem(`${sessionStorage.getItem("canvas-account")}:${name}`, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            window.localStorage.removeItem(`${sessionStorage.getItem("canvas-account")}:${name}`);
        }
    },
};
