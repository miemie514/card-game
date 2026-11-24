const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const ROLES = {
  warrior: { name: "战士", tag: "坦克", avatar: "warrior", desc: "被动：受伤-1。主动：对敌方造成3伤害（CD2）", passive: { trigger: "onDamaged", value: 1 }, active: { type: "damage", value: 3, target: "enemy", cooldown: 2 } },
  guard: { name: "守卫", tag: "坦克", avatar: "knight", desc: "被动：手牌上限+2。主动：替指定队友承伤直到下回合（CD3）", passive: { trigger: "handLimit", value: 2 }, active: { type: "taunt", value: 0, target: "ally", cooldown: 3 } },
  mage: { name: "法师", tag: "输出", avatar: "mage", desc: "被动：首张攻击牌+2伤。主动：弃1抽2（CD2）", passive: { trigger: "firstCardBonus", value: 2 }, active: { type: "draw", value: 2, target: "self", cooldown: 2 } },
  assassin: { name: "刺客", tag: "输出", avatar: "ninja", desc: "被动：打最低血+2伤。主动：本回合伤害+1（CD2）", passive: { trigger: "lowHpBonus", value: 2 }, active: { type: "buff", value: 1, target: "self", cooldown: 2 } },
  berserker: { name: "狂战士", tag: "输出", avatar: "viking", desc: "被动：血越低伤越高。主动：自损2，本回合+3伤（CD2）", passive: { trigger: "lowHpScale", value: 0 }, active: { type: "buff", value: 3, target: "self", cooldown: 2 } },
  priest: { name: "牧师", tag: "辅助", avatar: "angel", desc: "被动：回合回1血。主动：为队友回3血（CD2）", passive: { trigger: "onTurnStart", value: 1 }, active: { type: "heal", value: 3, target: "ally", cooldown: 2 } },
  bard: { name: "吟游诗人", tag: "辅助", avatar: "musician", desc: "被动：回合末抽1牌。主动：目标队友下回合多抽1牌（CD2）", passive: { trigger: "onTurnEnd", value: 1 }, active: { type: "drawBuff", value: 1, target: "ally", cooldown: 2 } },
  iceMage: { name: "冰法", tag: "控制", avatar: "snowman", desc: "被动：受击者少抽牌。主动：目标跳过出牌（CD3）", passive: { trigger: "onDamagedDebuff", value: 1 }, active: { type: "skip", value: 0, target: "enemy", cooldown: 3 } },
  rogue: { name: "盗贼", tag: "控制", avatar: "thief", desc: "被动：击杀偷牌。主动：弃敌方1张牌（CD2）", passive: { trigger: "onKill", value: 1 }, active: { type: "discard", value: 1, target: "enemy", cooldown: 2 } },
  gambler: { name: "赌徒", tag: "特殊", avatar: "joker", desc: "被动：伤害随机±2。主动：随机1~6伤害（CD3）", passive: { trigger: "randomDamage", value: 2 }, active: { type: "randomDamage", value: 6, target: "enemy", cooldown: 3 } }
};

const MAX_HP = 30;
const HAND_START = 5;

function buildDeck() {
  const deck = []; let id = 0;
  for (let i = 0; i < 10; i++) deck.push({ id: id++, type: "attack", name: "攻击", value: 3 });
  for (let i = 0; i < 6; i++) deck.push({ id: id++, type: "attack", name: "重击", value: 5 });
  for (let i = 0; i < 4; i++) deck.push({ id: id++, type: "heal", name: "治疗", value: 3 });
  for (let i = 0; i < 4; i++) deck.push({ id: id++, type: "shield", name: "护盾", value: 3 });
  for (let i = 0; i < 4; i++) deck.push({ id: id++, type: "draw", name: "抽牌", value: 2 });
  for (let i = 0; i < 4; i++) deck.push({ id: id++, type: "poison", name: "中毒", value: 2 });
  return shuffle(deck);
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const rooms = {};
function genRoomId() { let id; do { id = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms[id]); return id; }

function createRoom(hostSocketId, hostName) {
  const id = genRoomId();
  rooms[id] = { id, host: hostSocketId, status: "waiting", players: [], deck: [], discard: [], turnOrder: [], turnIndex: 0, log: [], lastAction: null, surrenderVotes: { A: [], B: [] }, winner: null };
  return rooms[id];
}
function addLog(room, text) { room.log.push(text); if (room.log.length > 50) room.log.shift(); }

function buildTurnOrder(room) {
  const A = room.players.filter(p => p.team === "A"); const B = room.players.filter(p => p.team === "B");
  const order = []; const maxLen = Math.max(A.length, B.length);
  for (let i = 0; i < maxLen; i++) { if (A[i]) order.push(A[i].id); if (B[i]) order.push(B[i].id); }
  room.turnOrder = order; room.turnIndex = 0;
}

function currentPlayer(room) {
  let guard = 0;
  while (guard++ < room.turnOrder.length * 2) {
    const pid = room.turnOrder[room.turnIndex % room.turnOrder.length];
    const p = room.players.find(x => x.id === pid);
    if (p && p.isAlive) return p;
    room.turnIndex++;
  }
  return null;
}

function nextTurn(room) {
  const oldP = currentPlayer(room);
  if (oldP && oldP.isAlive && ROLES[oldP.roleId].passive.trigger === "onTurnEnd") {
    drawCards(room, oldP, ROLES[oldP.roleId].passive.value);
    addLog(room, `${oldP.name} 被动触发，抽了1张牌`);
  }

  room.turnIndex++;
  const p = currentPlayer(room);
  if (p) {
    p.skipPlay = false;
    p.tauntTarget = null; 
    room.lastAction = null; 

    if (p.poison > 0) {
      p.hp -= 2; p.poison--;
      addLog(room, `☠️ ${p.name} 受到 2 点中毒伤害！剩余 ${p.poison} 回合`);
      room.lastAction = { actorId: p.id, name: p.name, cardName: "中毒发作", icon: "☠️", type: "poison" };
      if (p.hp <= 0) { p.hp = 0; p.isAlive = false; addLog(room, `${p.name} 毒发身亡`); }
    }

    if (p.isAlive) {
      const role = ROLES[p.roleId];
      if (role.passive.trigger === "onTurnStart") p.hp = Math.min(p.maxHp, p.hp + role.passive.value);
      p.cooldowns.active = Math.max(0, (p.cooldowns.active || 0) - 1);
      p.firstCardThisTurn = true;
      p.turnDamageBonus = 0;
      p.attackPlayedThisTurn = false; 
      
      let drawCount = 2 + (p.extraDraw || 0) - (p.lessDraw || 0);
      p.extraDraw = 0; p.lessDraw = 0;
      drawCards(room, p, Math.max(0, drawCount));
    }
    
    if (checkWin(room)) { broadcast(room); return; }
    broadcast(room);
    
    if (!p.isAlive) return nextTurn(room);
    if (p.isAI) setTimeout(() => aiTurnLogic(room, p), 1500);
  }
}

function drawCards(room, p, n) {
  for (let i = 0; i < n; i++) {
    if (room.deck.length === 0) { if (room.discard.length === 0) break; room.deck = shuffle(room.discard.splice(0)); }
    p.hand.push(room.deck.pop());
  }
  const limit = HAND_START + (ROLES[p.roleId].passive.trigger === "handLimit" ? ROLES[p.roleId].passive.value : 0);
  while (p.hand.length > limit) room.discard.push(p.hand.shift());
}

function publicState(room) {
  const cur = currentPlayer(room);
  return {
    id: room.id, status: room.status, host: room.host, currentTurnId: cur ? cur.id : null, lastAction: room.lastAction, winner: room.winner,
    players: room.players.map(p => ({
      id: p.id, name: p.name, seat: p.seat, team: p.team, roleId: p.roleId, hp: p.hp, maxHp: p.maxHp,
      shield: p.shield || 0, poison: p.poison || 0, tauntTarget: p.tauntTarget,
      isAlive: p.isAlive, handCount: p.hand.length, ready: p.ready, cooldowns: p.cooldowns, attackPlayed: p.attackPlayedThisTurn,
      isAI: p.isAI
    })),
    log: room.log.slice(-20)
  };
}

function broadcast(room) {
  const base = publicState(room);
  room.players.forEach(p => {
    if (p.isAI) return; 
    const sock = io.sockets.sockets.get(p.id);
    if (sock) sock.emit("stateUpdate", { ...base, yourHand: p.hand, yourId: p.id });
  });
}

function checkWin(room) {
  const A = room.players.filter(p => p.team === "A" && p.isAlive);
  const B = room.players.filter(p => p.team === "B" && p.isAlive);
  if (A.length === 0 || B.length === 0) {
    room.status = "ended";
    room.winner = A.length > 0 ? "A" : "B";
    addLog(room, `游戏结束，${room.winner}队获胜！`);
    return true;
  }
  return false;
}

function makePlayer(id, name, seat, isAI = false) {
  return { id, name, seat, team: "A", roleId: null, hp: MAX_HP, maxHp: MAX_HP, hand: [], isAlive: true, ready: false, cooldowns: { active: 0 }, skipPlay: false, turnDamageBonus: 0, firstCardThisTurn: true, extraDraw: 0, lessDraw: 0, tauntTarget: null, shield: 0, poison: 0, attackPlayedThisTurn: false, isAI };
}

function applyDamage(room, attacker, target, dmg) {
  const guard = room.players.find(x => x.isAlive && x.team === target.team && x.tauntTarget === target.id);
  if (guard && guard.id !== target.id) target = guard;
  
  const tRole = ROLES[target.roleId];
  if (tRole && tRole.passive.trigger === "onDamaged") dmg = Math.max(0, dmg - tRole.passive.value);
  if (target.shield > 0) { const absorb = Math.min(target.shield, dmg); target.shield -= absorb; dmg -= absorb; }
  target.hp -= dmg;
  addLog(room, `${attacker.name} 对 ${target.name} 造成${dmg}伤害`);
  
  if (tRole && tRole.passive.trigger === "onDamagedDebuff" && attacker.isAlive) attacker.lessDraw = (attacker.lessDraw || 0) + tRole.passive.value;
  
  if (target.hp <= 0) {
    target.hp = 0; target.isAlive = false; addLog(room, `${target.name} 阵亡`);
    const aRole = ROLES[attacker.roleId];
    if (aRole && aRole.passive.trigger === "onKill" && target.hand.length > 0) {
      const i = Math.floor(Math.random() * target.hand.length);
      attacker.hand.push(target.hand.splice(i, 1)[0]);
    }
  }
}

function handlePlayCard(room, p, cardId, targetId) {
  const idx = p.hand.findIndex(c => c.id === cardId);
  if (idx < 0) return { ok: false, msg: "手牌不存在" };
  const card = p.hand[idx];
  if (card.type === "attack" && p.attackPlayedThisTurn) return { ok: false, msg: "本回合已经出过攻击牌了！" };

  let target = null;
  if (["attack", "poison"].includes(card.type)) {
    target = room.players.find(x => x.id === targetId);
    if (!target || !target.isAlive || target.team === p.team) return { ok: false, msg: "必须选敌方" };
    if (card.type === "attack") p.attackPlayedThisTurn = true; 
  } else if (["heal", "shield"].includes(card.type)) {
    target = targetId ? room.players.find(x => x.id === targetId) : p;
    if (!target || !target.isAlive || target.team !== p.team) return { ok: false, msg: "只能对队友使用" };
  }

  p.hand.splice(idx, 1); room.discard.push(card);
  
  let icon = card.type === "attack" ? "⚔️" : card.type === "heal" ? "💚" : card.type === "shield" ? "🛡️" : card.type === "poison" ? "☠️" : "🎴";
  room.lastAction = { actorId: p.id, name: p.name, cardName: card.name, icon, type: card.type };

  if (card.type === "attack") {
    let dmg = card.value + (p.turnDamageBonus || 0);
    const role = ROLES[p.roleId];
    if (role.passive.trigger === "firstCardBonus" && p.firstCardThisTurn) dmg += role.passive.value;
    if (role.passive.trigger === "lowHpBonus") {
      const lowest = Math.min(...room.players.filter(x => x.isAlive).map(x => x.hp));
      if (target.hp === lowest) dmg += role.passive.value;
    }
    if (role.passive.trigger === "lowHpScale") dmg += Math.floor((1 - p.hp / p.maxHp) * 5);
    if (role.passive.trigger === "randomDamage") dmg += Math.floor(Math.random() * (role.passive.value * 2 + 1)) - role.passive.value;
    applyDamage(room, p, target, dmg);
  } else if (card.type === "poison") {
    target.poison = (target.poison || 0) + card.value;
    addLog(room, `${p.name} 对 ${target.name} 施加了中毒(${card.value}回合)`);
  } else if (card.type === "heal") {
    target.hp = Math.min(target.maxHp, target.hp + card.value);
    addLog(room, `${p.name} 治疗 ${target.name} ${card.value}血`);
  } else if (card.type === "shield") {
    target.shield = (target.shield || 0) + card.value;
    addLog(room, `${p.name} 给 ${target.name} 护盾${card.value}`);
  } else if (card.type === "draw") {
    drawCards(room, p, card.value);
    addLog(room, `${p.name} 抽了${card.value}张牌`);
  }

  p.firstCardThisTurn = false;
  return { ok: true };
}

function handleUseSkill(room, p, targetId) {
  const role = ROLES[p.roleId];
  if (!role.active) return { ok: false };
  if ((p.cooldowns.active || 0) > 0) return { ok: false };

  const t = role.active.target;
  let target = null;
  if (t === "self") target = p;
  else {
    target = room.players.find(x => x.id === targetId);
    if (!target || !target.isAlive) return { ok: false };
    if (t === "enemy" && target.team === p.team) return { ok: false };
    if (t === "ally" && target.team !== p.team) return { ok: false };
  }

  const a = role.active; p.cooldowns.active = a.cooldown;
  room.lastAction = { actorId: p.id, name: p.name, cardName: role.name + "的技能", icon: "✨", type: "skill" };

  if (a.type === "damage") applyDamage(room, p, target, a.value);
  else if (a.type === "heal") { target.hp = Math.min(target.maxHp, target.hp + a.value); addLog(room, `${p.name} 技能治疗 ${target.name}`); }
  else if (a.type === "draw") { if (p.hand.length > 0) room.discard.push(p.hand.shift()); drawCards(room, p, a.value); }
  else if (a.type === "buff") {
    if (p.roleId === "berserker") p.hp = Math.max(1, p.hp - 2);
    p.turnDamageBonus = (p.turnDamageBonus || 0) + a.value; addLog(room, `${p.name} 获得伤害加成`);
  } else if (a.type === "taunt") { p.tauntTarget = target.id; addLog(room, `${p.name} 守护了 ${target.name}`); }
  else if (a.type === "skip") { target.skipPlay = true; addLog(room, `${p.name} 冻结 ${target.name}`); }
  else if (a.type === "discard") {
    if (target.hand.length > 0) {
      const i = Math.floor(Math.random() * target.hand.length);
      room.discard.push(target.hand.splice(i, 1)[0]); addLog(room, `${p.name} 弃掉了 ${target.name} 一张牌`);
    }
  } else if (a.type === "drawBuff") { target.extraDraw = (target.extraDraw || 0) + a.value; addLog(room, `${p.name} 让 ${target.name} 下回合多抽牌`); }
  else if (a.type === "randomDamage") { const dmg = Math.floor(Math.random() * a.value) + 1; applyDamage(room, p, target, dmg); }

  return { ok: true };
}

function aiTurnLogic(room, ai) {
  if (room.status !== "playing") return;
  const cur = currentPlayer(room);
  if (!cur || cur.id !== ai.id) return; 
  if (!ai.isAlive) { if (!checkWin(room)) nextTurn(room); broadcast(room); return; }

  const enemies = room.players.filter(p => p.team !== ai.team && p.isAlive);
  const allies = room.players.filter(p => p.team === ai.team && p.isAlive);
  
  const role = ROLES[ai.roleId];
  if (ai.cooldowns.active === 0 && Math.random() > 0.4) {
    let targetId = ai.id;
    if (role.active.target === "enemy" && enemies.length > 0) targetId = enemies.sort((a,b)=>a.hp-b.hp)[0].id;
    if (role.active.target === "ally" && allies.length > 0) targetId = allies.sort((a,b)=>a.hp-b.hp)[0].id;
    
    const res = handleUseSkill(room, ai, targetId);
    if (res.ok) {
      if (checkWin(room)) { broadcast(room); return; }
      broadcast(room);
      return setTimeout(() => aiTurnLogic(room, ai), 1200);
    }
  }

  const playable = ai.hand.filter(c => !(c.type === "attack" && ai.attackPlayedThisTurn));
  if (playable.length > 0) {
    let res = { ok: false };
    const attackCard = playable.find(c => c.type === "attack" || c.type === "poison");
    
    if (attackCard && enemies.length > 0) {
      const target = enemies.sort((a,b)=>a.hp-b.hp)[0];
      res = handlePlayCard(room, ai, attackCard.id, target.id);
    } else {
      const healCard = playable.find(c => c.type === "heal" || c.type === "shield");
      const hurtAllies = allies.filter(a => a.hp < a.maxHp);
      if (healCard && hurtAllies.length > 0) {
        const target = hurtAllies.sort((a,b)=>a.hp-b.hp)[0];
        res = handlePlayCard(room, ai, healCard.id, target.id);
      } else {
        const anyPlayable = playable[0];
        if (anyPlayable.type === 'heal' || anyPlayable.type === 'shield') {
           res = handlePlayCard(room, ai, anyPlayable.id, ai.id);
        } else if (enemies.length > 0) {
           res = handlePlayCard(room, ai, anyPlayable.id, enemies[0].id);
        } else {
           const idx = ai.hand.findIndex(c => c.id === anyPlayable.id);
           if (idx >= 0) room.discard.push(ai.hand.splice(idx, 1)[0]);
           res = { ok: true };
        }
      }
    }
    
    if (!res.ok) {
      const idx = ai.hand.findIndex(c => c.id === playable[0].id);
      if (idx >= 0) room.discard.push(ai.hand.splice(idx, 1)[0]);
    }

    if (checkWin(room)) { broadcast(room); return; }
    broadcast(room);
    return setTimeout(() => aiTurnLogic(room, ai), 1200); 
  }

  setTimeout(() => {
    if (!checkWin(room)) nextTurn(room);
    broadcast(room);
  }, 1000);
}

io.on("connection", socket => {
  let roomId = null;

  socket.on("startAIGame", ({ name }, cb) => {
    const room = createRoom(socket.id, name);
    const p1 = makePlayer(socket.id, name, 0);
    const p2 = makePlayer("ai_ally", "AI队友", 1, true); 
    const p3 = makePlayer("ai_enemy1", "AI敌人A", 2, true);
    const p4 = makePlayer("ai_enemy2", "AI敌人B", 3, true);

    p1.team = "A"; p2.team = "A"; p3.team = "B"; p4.team = "B";

    room.players.push(p1, p2, p3, p4);
    roomId = room.id; socket.join(roomId);

    const roleKeys = Object.keys(ROLES).sort(() => Math.random() - 0.5);
    p2.roleId = roleKeys[0];
    p3.roleId = roleKeys[1];
    p4.roleId = roleKeys[2];

    if (typeof cb === "function") cb({ ok: true, roomId: room.id });
    addLog(room, `${name} 开启了单机 AI 对战`);
    room.status = "choosing";
    broadcast(room);
  });

  socket.on("createRoom", ({ name }, cb) => {
    const room = createRoom(socket.id, name);
    const p = makePlayer(socket.id, name, 0);
    p.team = "A";
    room.players.push(p);
    roomId = room.id; socket.join(roomId);
    if (typeof cb === "function") cb({ ok: true, roomId: room.id }); 
    broadcast(room);
  });

  socket.on("joinRoom", ({ name, roomId: rid }, cb) => {
    const room = rooms[rid];
    if (!room) return cb({ ok: false, msg: "房间不存在" });
    if (room.status !== "waiting" && room.status !== "choosing") return cb({ ok: false, msg: "游戏已开始" });
    if (room.players.length >= 6) return cb({ ok: false, msg: "房间已满" });
    if (room.players.some(p => p.name === name)) return cb({ ok: false, msg: "昵称重复" });

    const p = makePlayer(socket.id, name, room.players.length);
    // 自动去人少的队伍
    const teamA = room.players.filter(x => x.team === "A").length;
    const teamB = room.players.filter(x => x.team === "B").length;
    p.team = teamA <= teamB ? "A" : "B";

    room.players.push(p);
    roomId = rid; socket.join(rid); broadcast(room);
    cb({ ok: true, roomId: rid });
  });

  socket.on("switchTeam", ({ team }, cb) => {
    const room = rooms[roomId]; if (!room || room.status === "playing") return;
    const p = room.players.find(x => x.id === socket.id); if (!p) return;
    
    const teamCount = room.players.filter(x => x.team === team).length;
    if (teamCount >= 3) return cb({ ok: false, msg: "该队伍已满(3人)" });
    
    p.team = team;
    if (typeof cb === "function") cb({ ok: true });
    broadcast(room);
  });

  socket.on("addAI", ({ team }, cb) => {
    const room = rooms[roomId]; if (!room || room.status === "playing" || room.host !== socket.id) return;
    const teamCount = room.players.filter(x => x.team === team).length;
    if (teamCount >= 3) return cb({ ok: false, msg: "该队伍已满" });

    const aiId = "ai_" + Date.now() + Math.floor(Math.random()*1000);
    const aiP = makePlayer(aiId, "AI_" + Math.floor(Math.random()*100), 0, true);
    aiP.team = team;
    
    // 随机未选角色
    const availableRoles = Object.keys(ROLES).filter(r => !room.players.some(p => p.roleId === r));
    if (availableRoles.length > 0) aiP.roleId = availableRoles[Math.floor(Math.random() * availableRoles.length)];

    room.players.push(aiP);
    if (typeof cb === "function") cb({ ok: true });
    broadcast(room);
  });

  socket.on("removeAI", ({ aiId }, cb) => {
    const room = rooms[roomId]; if (!room || room.status === "playing" || room.host !== socket.id) return;
    room.players = room.players.filter(p => p.id !== aiId);
    if (typeof cb === "function") cb({ ok: true });
    broadcast(room);
  });

  socket.on("selectRole", ({ roleId }, cb) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.players.find(x => x.id === socket.id); if (!p || room.status === "playing") return;
    if (room.players.some(x => x.id !== socket.id && x.roleId === roleId)) return cb({ ok: false, msg: "该角色已被选" });
    p.roleId = roleId; room.status = "choosing"; cb({ ok: true }); broadcast(room);
  });

  socket.on("startGame", (_, cb) => {
    const room = rooms[roomId]; if (!room) return cb({ ok: false, msg: "房间不存在" });
    if (room.host !== socket.id) return cb({ ok: false, msg: "只有房主能开始" });
    
    const teamA = room.players.filter(p => p.team === "A");
    const teamB = room.players.filter(p => p.team === "B");
    if (teamA.length === 0 || teamB.length === 0 || teamA.length !== teamB.length) {
      return cb({ ok: false, msg: "两队人数必须相等且大于0" });
    }
    if (teamA.length > 3) return cb({ ok: false, msg: "每个队伍最多3人" });
    if (!room.players.every(p => p.roleId)) return cb({ ok: false, msg: "还有玩家或AI未选角" });

    room.status = "playing"; room.deck = buildDeck(); room.discard = []; room.log = []; room.lastAction = null; room.surrenderVotes = { A: [], B: [] }; room.winner = null;
    room.players.forEach(p => {
      p.hp = MAX_HP; p.hand = []; p.isAlive = true; p.cooldowns = { active: 0 }; p.skipPlay = false; p.turnDamageBonus = 0;
      p.firstCardThisTurn = true; p.extraDraw = 0; p.lessDraw = 0; p.tauntTarget = null; p.attackPlayedThisTurn = false; p.shield = 0; p.poison = 0;
      drawCards(room, p, HAND_START);
    });
    buildTurnOrder(room);
    const first = currentPlayer(room);
    addLog(room, `游戏开始！${first.name} 先手`);
    cb({ ok: true }); broadcast(room);

    if (first.isAI) setTimeout(() => aiTurnLogic(room, first), 1500);
  });

  socket.on("backToRoom", (_, cb) => {
    const room = rooms[roomId]; if (!room) return;
    room.status = "choosing";
    room.winner = null;
    room.players.forEach(p => {
      p.hp = MAX_HP; p.hand = []; p.isAlive = true; p.shield = 0; p.poison = 0; p.tauntTarget = null;
    });
    broadcast(room);
    if (typeof cb === "function") cb({ ok: true });
  });

  socket.on("playCard", ({ cardId, targetId }, cb) => {
    const room = rooms[roomId]; if (!room || room.status !== "playing") return;
    const p = room.players.find(x => x.id === socket.id); const cur = currentPlayer(room);
    if (!p || !cur || cur.id !== p.id) return cb({ ok: false, msg: "不是你的回合" });
    if (p.skipPlay) return cb({ ok: false, msg: "你被冻结" });

    const res = handlePlayCard(room, p, cardId, targetId);
    if (!res.ok) return cb(res);
    checkWin(room); cb({ ok: true }); broadcast(room); 
  });

  socket.on("useSkill", ({ targetId }, cb) => {
    const room = rooms[roomId]; if (!room || room.status !== "playing") return;
    const p = room.players.find(x => x.id === socket.id); const cur = currentPlayer(room);
    if (!p || !cur || cur.id !== p.id) return cb({ ok: false, msg: "不是你的回合" });

    const res = handleUseSkill(room, p, targetId);
    if (!res.ok) return cb(res);
    checkWin(room); cb({ ok: true }); broadcast(room);
  });

  socket.on("endTurn", (_, cb) => {
    const room = rooms[roomId]; if (!room || room.status !== "playing") return;
    const p = room.players.find(x => x.id === socket.id); const cur = currentPlayer(room);
    if (!p || !cur || cur.id !== p.id) return cb({ ok: false, msg: "不是你的回合" });
    
    if (!checkWin(room)) nextTurn(room);
    cb({ ok: true }); broadcast(room);
  });

  socket.on("surrender", (_, cb) => {
    const room = rooms[roomId]; if (!room || room.status !== "playing") return;
    const p = room.players.find(x => x.id === socket.id);
    if (!p || !p.isAlive) return;

    const team = p.team;
    if (!room.surrenderVotes[team].includes(p.id)) room.surrenderVotes[team].push(p.id);
    
    const aiTeammates = room.players.filter(x => x.team === team && x.isAI && x.isAlive);
    aiTeammates.forEach(ai => {
      if (!room.surrenderVotes[team].includes(ai.id)) room.surrenderVotes[team].push(ai.id);
    });

    if (room.surrenderVotes[team].length >= Math.ceil(room.players.filter(x=>x.team===team && x.isAlive).length / 2)) {
      room.status = "ended";
      room.winner = team === "A" ? "B" : "A";
      addLog(room, `${team} 队投降，${room.winner} 队获胜！`);
      broadcast(room);
    } else {
      const realTeammates = room.players.filter(x => x.team === team && x.id !== p.id && !x.isAI);
      realTeammates.forEach(t => {
        const sock = io.sockets.sockets.get(t.id);
        if (sock) sock.emit("surrenderRequest", { name: p.name });
      });
    }
    if (typeof cb === "function") cb({ ok: true });
  });

  socket.on("voteSurrender", (data, cb) => {
    const room = rooms[roomId]; if (!room || room.status !== "playing") return;
    const p = room.players.find(x => x.id === socket.id);
    if (!p || !p.isAlive) return;

    const team = p.team;
    if (data.agree) {
      if (!room.surrenderVotes[team].includes(p.id)) room.surrenderVotes[team].push(p.id);
      if (room.surrenderVotes[team].length >= Math.ceil(room.players.filter(x=>x.team===team && x.isAlive).length / 2)) {
        room.status = "ended";
        room.winner = team === "A" ? "B" : "A";
        addLog(room, `${team} 队投降，${room.winner} 队获胜！`);
        broadcast(room);
      }
    }
    if (typeof cb === "function") cb({ ok: true });
  });

  socket.on("disconnect", () => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.players.find(x => x.id === socket.id); if (!p) return;
    if (room.status === "playing") {
      p.isAlive = false; addLog(room, `${p.name} 掉线阵亡`);
      if (!checkWin(room)) nextTurn(room);
      broadcast(room);
    } else {
      room.players = room.players.filter(x => x.id !== socket.id);
      if (room.players.length === 0) delete rooms[roomId];
      else { 
        if (room.host === socket.id) room.host = room.players.find(x=>!x.isAI)?.id; 
        broadcast(room); 
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`服务器运行：http://localhost:${PORT}`));