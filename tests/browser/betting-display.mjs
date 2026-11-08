import adjustments from './adjustments.mjs';

export default (pages, sleep, roomPassword) =>
  adjustments(pages, sleep, roomPassword, {bettingDisplayOnly:true});
