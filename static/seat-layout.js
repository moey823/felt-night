(function (root) {
  "use strict";

  var EDGE = 5;
  var GAP = 5;
  var BEAM_WIDTH = 36;
  var CANDIDATE_LIMIT = 128;
  var HARD_PENALTY = 1000000000;
  var cacheKey = null;
  var cacheValue = null;

  function number(value, fallback) {
    var result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }

  function clamp(value, low, high) {
    if (high < low) return (low + high) / 2;
    return Math.max(low, Math.min(high, value));
  }

  function normalizeRect(rect) {
    var left = number(rect && rect.left, 0);
    var top = number(rect && rect.top, 0);
    var right = number(rect && rect.right, left);
    var bottom = number(rect && rect.bottom, top);
    return {
      left: Math.min(left, right),
      top: Math.min(top, bottom),
      right: Math.max(left, right),
      bottom: Math.max(top, bottom)
    };
  }

  function angle(x, y, width, height) {
    var value = Math.atan2(y - height / 2, x - width / 2);
    return value < 0 ? value + Math.PI * 2 : value;
  }

  function angleDistance(a, b) {
    var d = Math.abs(a - b) % (Math.PI * 2);
    return Math.min(d, Math.PI * 2 - d);
  }

  function copyResult(value) {
    return value.map(function (item) {
      return { id: item.id, x: item.x, y: item.y };
    });
  }

  function fit(input) {
    input = input || {};
    var width = Math.max(0, number(input.width, 0));
    var height = Math.max(0, number(input.height, 0));
    var sourceSeats = Array.isArray(input.seats) ? input.seats : [];
    if (!sourceSeats.length) return [];

    var sourceBlockers = Array.isArray(input.blockers) ? input.blockers : [];
    var key;
    try {
      // A hand's board, pot, and content rows have reserved footprints. Keep
      // the first collision-safe seat placement for this viewport and seat set
      // while those occupants change text or cards during the hand.
      key = JSON.stringify({
        width: width,
        height: height,
        seats: sourceSeats.map(function (seat) {
          return [
            seat && seat.id,
            number(seat && seat.x, 0),
            number(seat && seat.y, 0),
            number(seat && seat.width, 76),
            number(seat && seat.height, 68),
            Boolean(seat && seat.hero)
          ];
        })
      });
      if (key === cacheKey && cacheValue) return copyResult(cacheValue);
    } catch (_) {
      key = null;
    }

    var blockers = sourceBlockers.map(normalizeRect);
    var seats = sourceSeats.map(function (seat, index) {
      seat = seat || {};
      var seatWidth = Math.max(1, number(seat.width, 76));
      var seatHeight = Math.max(1, number(seat.height, 68));
      var minX = EDGE + seatWidth / 2;
      var maxX = width - EDGE - seatWidth / 2;
      var minY = EDGE + seatHeight / 2;
      var maxY = height - EDGE - seatHeight / 2;
      var idealX = number(seat.x, width / 2);
      var idealY = number(seat.y, height / 2);
      var hero = Boolean(seat.hero);
      return {
        id: seat.id,
        index: index,
        width: seatWidth,
        height: seatHeight,
        hero: hero,
        idealX: idealX,
        idealY: idealY,
        x: hero ? idealX : clamp(idealX, minX, maxX),
        y: hero ? idealY : clamp(idealY, minY, maxY),
        minX: minX,
        maxX: maxX,
        minY: minY,
        maxY: maxY,
        edgeImpossible: maxX < minX || maxY < minY,
        idealAngle: angle(idealX, idealY, width, height)
      };
    });

    function isClear(seat, point, placed) {
      if (seat.edgeImpossible) return false;
      if (point.x < seat.minX - 0.01 || point.x > seat.maxX + 0.01 ||
          point.y < seat.minY - 0.01 || point.y > seat.maxY + 0.01) return false;

      var left = point.x - seat.width / 2;
      var right = point.x + seat.width / 2;
      var top = point.y - seat.height / 2;
      var bottom = point.y + seat.height / 2;
      for (var b = 0; b < blockers.length; b++) {
        var blocker = blockers[b];
        if (right + GAP > blocker.left && left - GAP < blocker.right &&
            bottom + GAP > blocker.top && top - GAP < blocker.bottom) return false;
      }
      for (var p = 0; p < placed.length; p++) {
        var otherPoint = placed[p];
        if (!otherPoint) continue;
        var other = seats[p];
        if (Math.abs(point.x - otherPoint.x) <
              (seat.width + other.width) / 2 + GAP &&
            Math.abs(point.y - otherPoint.y) <
              (seat.height + other.height) / 2 + GAP) return false;
      }
      return true;
    }

    var idealPositions = seats.map(function (seat) {
      return { x: seat.x, y: seat.y };
    });
    var idealsClear = seats.every(function (seat) {
      return isClear(seat, idealPositions[seat.index], idealPositions.slice(0, seat.index));
    });
    if (idealsClear) {
      var exact = seats.map(function (seat) {
        return { id: seat.id, x: seat.x, y: seat.y };
      });
      if (key) {
        cacheKey = key;
        cacheValue = copyResult(exact);
      }
      return exact;
    }

    var heroIndex = seats.findIndex(function (seat) { return seat.hero; });
    var idealOrder = seats.map(function (seat) { return seat.index; }).sort(function (a, b) {
      return seats[a].idealAngle - seats[b].idealAngle || a - b;
    });
    var placementOrder = [];
    if (heroIndex >= 0) {
      var heroPosition = idealOrder.indexOf(heroIndex);
      for (var h = 0; h < idealOrder.length; h++) {
        placementOrder.push(idealOrder[(heroPosition + h) % idealOrder.length]);
      }
    } else {
      placementOrder = idealOrder.slice();
    }

    function candidateCost(seat, point) {
      var scaleX = Math.max(24, width * 0.18);
      var scaleY = Math.max(24, height * 0.18);
      var dx = (point.x - seat.idealX) / scaleX;
      var dy = (point.y - seat.idealY) / scaleY;
      var targetAngle = angle(point.x, point.y, width, height);
      var angular = angleDistance(targetAngle, seat.idealAngle);
      var weight = seat.hero ? 2.8 : 1;
      return weight * (dx * dx + dy * dy + angular * angular * 0.32);
    }

    function candidatesFor(seat) {
      if (seat.hero) {
        return [{ x: seat.x, y: seat.y, key: seat.x + ":" + seat.y }];
      }
      var points = [];
      var seen = Object.create(null);
      function add(x, y) {
        x = clamp(x, seat.minX, seat.maxX);
        y = clamp(y, seat.minY, seat.maxY);
        var px = Math.round(x * 2) / 2;
        var py = Math.round(y * 2) / 2;
        var pointKey = px + ":" + py;
        if (seen[pointKey]) return;
        seen[pointKey] = true;
        points.push({ x: px, y: py, key: pointKey });
      }

      add(seat.idealX, seat.idealY);
      add(seat.x, seat.y);

      var stepX = seat.width + GAP;
      var stepY = seat.height + GAP;
      var scales = [0.55, 1, 1.5];
      var directions = [
        [-1, 0], [1, 0], [0, -1], [0, 1],
        [-1, -1], [1, -1], [-1, 1], [1, 1]
      ];
      for (var s = 0; s < scales.length; s++) {
        for (var d = 0; d < directions.length; d++) {
          add(
            seat.idealX + directions[d][0] * stepX * scales[s],
            seat.idealY + directions[d][1] * stepY * scales[s]
          );
        }
      }

      for (var b = 0; b < blockers.length; b++) {
        var block = blockers[b];
        var leftX = block.left - GAP - seat.width / 2;
        var rightX = block.right + GAP + seat.width / 2;
        var topY = block.top - GAP - seat.height / 2;
        var bottomY = block.bottom + GAP + seat.height / 2;
        var alignYs = [
          seat.idealY, topY, bottomY,
          (block.top + block.bottom) / 2
        ];
        var alignXs = [
          seat.idealX, leftX, rightX,
          (block.left + block.right) / 2
        ];
        for (var y = 0; y < alignYs.length; y++) {
          add(leftX, alignYs[y]);
          add(rightX, alignYs[y]);
        }
        for (var x = 0; x < alignXs.length; x++) {
          add(alignXs[x], topY);
          add(alignXs[x], bottomY);
        }
        add(leftX, topY);
        add(rightX, topY);
        add(leftX, bottomY);
        add(rightX, bottomY);
      }

      var rangeX = Math.max(0, seat.maxX - seat.minX);
      var rangeY = Math.max(0, seat.maxY - seat.minY);
      var columns = seat.edgeImpossible ? 1 :
        Math.max(1, Math.floor((rangeX + GAP) / stepX) + 1);
      var rows = seat.edgeImpossible ? 1 :
        Math.max(1, Math.floor((rangeY + GAP) / stepY) + 1);
      columns = Math.min(columns, 18);
      rows = Math.min(rows, 18);
      for (var row = 0; row < rows; row++) {
        var gy = rows === 1 ? (seat.minY + seat.maxY) / 2 :
          seat.minY + rangeY * row / (rows - 1);
        for (var col = 0; col < columns; col++) {
          var gx = columns === 1 ? (seat.minX + seat.maxX) / 2 :
            seat.minX + rangeX * col / (columns - 1);
          add(gx, gy);
          if (columns > 1 && col + 1 < columns && row % 2 === 1) {
            add((gx + (seat.minX + rangeX * (col + 1) / (columns - 1))) / 2, gy);
          }
        }
      }

      points.sort(function (a, b) {
        return candidateCost(seat, a) - candidateCost(seat, b) ||
          a.y - b.y || a.x - b.x;
      });
      if (points.length > CANDIDATE_LIMIT) points.length = CANDIDATE_LIMIT;
      return points;
    }

    var candidateSets = seats.map(candidatesFor);

    function collisionCost(seat, point, placed) {
      var conflicts = 0;
      var severity = 0;
      var left = point.x - seat.width / 2;
      var right = point.x + seat.width / 2;
      var top = point.y - seat.height / 2;
      var bottom = point.y + seat.height / 2;
      var edgeX = Math.max(0, seat.minX - seat.maxX);
      var edgeY = Math.max(0, seat.minY - seat.maxY);
      if (edgeX > 0 || edgeY > 0) {
        conflicts++;
        severity += edgeX + edgeY + 1;
      }
      if (left < EDGE) {
        conflicts++;
        severity += EDGE - left;
      }
      if (right > width - EDGE) {
        conflicts++;
        severity += right - (width - EDGE);
      }
      if (top < EDGE) {
        conflicts++;
        severity += EDGE - top;
      }
      if (bottom > height - EDGE) {
        conflicts++;
        severity += bottom - (height - EDGE);
      }
      for (var b = 0; b < blockers.length; b++) {
        var block = blockers[b];
        var ox = Math.min(right + GAP, block.right) - Math.max(left - GAP, block.left);
        var oy = Math.min(bottom + GAP, block.bottom) - Math.max(top - GAP, block.top);
        if (ox > 0 && oy > 0) {
          conflicts++;
          severity += ox * oy;
        }
      }
      for (var p = 0; p < placed.length; p++) {
        var otherPoint = placed[p];
        if (!otherPoint) continue;
        var other = seats[p];
        var overlapX = (seat.width + other.width) / 2 + GAP - Math.abs(point.x - otherPoint.x);
        var overlapY = (seat.height + other.height) / 2 + GAP - Math.abs(point.y - otherPoint.y);
        if (overlapX > 0 && overlapY > 0) {
          conflicts++;
          severity += overlapX * overlapY;
        }
      }
      return { conflicts: conflicts, severity: severity };
    }

    function stateScore(state) {
      return state.conflicts * HARD_PENALTY +
        state.severity * 10000 + state.cost;
    }

    function stateKey(state) {
      return state.positions.map(function (point) {
        return point ? point.key : "-";
      }).join("|");
    }

    var beam = [{
      positions: new Array(seats.length),
      conflicts: 0,
      severity: 0,
      cost: 0,
      key: ""
    }];
    for (var orderIndex = 0; orderIndex < placementOrder.length; orderIndex++) {
      var seatIndex = placementOrder[orderIndex];
      var seat = seats[seatIndex];
      var candidates = candidateSets[seatIndex];
      var expanded = [];
      for (var stateIndex = 0; stateIndex < beam.length; stateIndex++) {
        var state = beam[stateIndex];
        for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
          var candidate = candidates[candidateIndex];
          var collisions = collisionCost(seat, candidate, state.positions);
          var positions = state.positions.slice();
          positions[seatIndex] = candidate;
          expanded.push({
            positions: positions,
            conflicts: state.conflicts + collisions.conflicts,
            severity: state.severity + collisions.severity,
            cost: state.cost + candidateCost(seat, candidate),
            key: ""
          });
        }
      }
      expanded.sort(function (a, b) {
        return stateScore(a) - stateScore(b);
      });
      var next = [];
      var nextKeys = Object.create(null);
      for (var e = 0; e < expanded.length && next.length < BEAM_WIDTH; e++) {
        var expandedKey = stateKey(expanded[e]);
        if (nextKeys[expandedKey]) continue;
        nextKeys[expandedKey] = true;
        expanded[e].key = expandedKey;
        next.push(expanded[e]);
      }
      beam = next;
    }

    function clockwisePenalty(positions) {
      var actualOrder = seats.map(function (seat) { return seat.index; }).sort(function (a, b) {
        return angle(positions[a].x, positions[a].y, width, height) -
          angle(positions[b].x, positions[b].y, width, height) || a - b;
      });
      var ideal = idealOrder;
      var best = Infinity;
      for (var shift = 0; shift < actualOrder.length; shift++) {
        var ranks = Object.create(null);
        for (var i = 0; i < ideal.length; i++) ranks[ideal[i]] = i;
        var inversions = 0;
        for (var a = 0; a < actualOrder.length; a++) {
          for (var b = a + 1; b < actualOrder.length; b++) {
            var left = actualOrder[(shift + a) % actualOrder.length];
            var right = actualOrder[(shift + b) % actualOrder.length];
            if (ranks[left] > ranks[right]) inversions++;
          }
        }
        best = Math.min(best, inversions);
      }
      return best;
    }

    beam.sort(function (a, b) {
      var scoreA = stateScore(a) + clockwisePenalty(a.positions) * 16;
      var scoreB = stateScore(b) + clockwisePenalty(b.positions) * 16;
      return scoreA - scoreB;
    });
    var chosen = beam.length ? beam[0].positions : idealPositions;
    var result = seats.map(function (seat) {
      var point = chosen[seat.index] || idealPositions[seat.index];
      return {
        id: seat.id,
        x: Math.round(point.x * 100) / 100,
        y: Math.round(point.y * 100) / 100
      };
    });
    if (key) {
      cacheKey = key;
      cacheValue = copyResult(result);
    }
    return result;
  }

  root.SitNgoLayout = { fit: fit };
})(typeof window !== "undefined" ? window : globalThis);
