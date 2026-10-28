import { getPersistedKeybindingsState } from "../persisted-state";

// Compound clip shortcuts; keys the user already bound keep their action.
const ADDED_SHORTCUTS = {
	"alt+g": "create-compound",
	"alt+shift+g": "break-apart-compound",
} as const;

export function v7ToV8({ state }: { state: unknown }): unknown {
	const v7 = getPersistedKeybindingsState({ state });
	if (!v7) return state;
	const keybindings = { ...v7.keybindings };

	for (const [key, action] of Object.entries(ADDED_SHORTCUTS)) {
		if (!keybindings[key]) {
			keybindings[key] = action;
		}
	}

	return { ...v7, keybindings };
}
