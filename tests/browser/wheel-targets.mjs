import adjustments from './adjustments.mjs';

export default (pages, sleep, roomPassword) =>
  adjustments(pages, sleep, roomPassword, {wheelTargetsOnly:true});
