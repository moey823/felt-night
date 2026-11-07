// Seed a throwaway browser-test account with one validated catalog portrait before table entry.
export async function seedAvatar(apiRequest, session, presetId = "fish") {
  const result = await apiRequest("/profile/avatar", session, {preset_id:presetId});
  const player = result?.player;
  if (!player?.avatar_url) {
    throw Error("Could not save the " + presetId + " test avatar before table entry.");
  }
  return player;
}
