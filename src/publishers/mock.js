// Safe fallback used when a platform has no real credentials configured (or
// for accounts connected in sandbox mode). The full pipeline still exercises
// status transitions, retries and logging — only the network call is faked.
export const mock = {
  async publish({ account, post }) {
    const id = `mock_${account.platform}_${Date.now().toString(36)}`;
    return { platformPostId: id, simulated: true };
  },
};
