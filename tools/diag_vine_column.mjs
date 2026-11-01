/**
 * 在最靠近用户位置的藤蔓柱上复现"爬上去再跳下来"。
 * 现场实测：(-232,-284) 有 8 格藤蔓柱 y=67..74，紧挨 bot 站位。
 *
 * 做法：让 bot 从柱子一侧走向另一侧（目标在柱子背后），
 * 分别用默认 Movements 和"移除藤蔓攀爬"，看是否出现"绕柱爬升"。
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { blockAt } from '../src/agent/library/query_perceive.js';
import Vec3 from 'vec3';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const RC=(c)=>rcon(c,{port:25575});
const NAME='vc2'+(Date.now()%100000);
const bot=mineflayer.createBot({host:'127.0.0.1',port:25565,username:NAME,auth:'offline',version:'1.21.8'});
bot.loadPlugin(pf.pathfinder); installPositionGuard(bot);
bot.on('error',()=>{});
bot.on('kicked',(r)=>console.log('KICKED',JSON.stringify(r).slice(0,80)));
bot.once('spawn',async()=>{
  await sleep(2500);
  await RC(`op ${NAME}`); await RC(`gamemode survival ${NAME}`);
  const cx=Math.floor(-233/16), cz=Math.floor(-284/16);
  await RC(`forceload add ${cx-8} ${cz-8} ${cx+8} ${cz+8}`);
  await sleep(1000);

  // 藤蔓柱位置（现场实测）
  const VX=-232, VZ=-284;
  let col=[];
  for(let y=67;y<=76;y++){
    const b=blockAt(bot,{x:VX,y,z:VZ});
    col.push(b?.name==='vine'?'v':(b?.name==='air'?'.':'#'));
  }
  console.log(`藤蔓柱 (${VX},${VZ}) y=67..76: ${col.join('')}`);

  /** 从柱东侧走到柱西侧；记录最大高度与上升次数 */
  const runCase=async(label, mutate, goal)=>{
    await RC(`tp ${NAME} ${VX+5.5} 68 ${VZ+0.5}`);
    await sleep(2200);
    const s=bot.entity.position.clone();
    const m=new pf.Movements(bot); m.canOpenDoors=true; m.maxDropDown=3;
    mutate(m); bot.pathfinder.setMovements(m);
    let maxY=s.y, climbs=0, lastY=s.y;
    const iv=setInterval(()=>{const y=bot.entity.position.y; if(y>maxY)maxY=y; if(y-lastY>0.35)climbs++; lastY=y;},100);
    const t0=Date.now(); let code='OK', msg='';
    try{
      await Promise.race([
        bot.pathfinder.goto(new pf.goals.GoalNear(goal.x, goal.y, goal.z, 1)),
        sleep(30000).then(()=>{throw new Error('30s-timeout')}),
      ]);
    }catch(e){ code=e.message.includes('timeout')?'TIMEOUT':'ERR'; msg=String(e.message).slice(0,30); }
    clearInterval(iv);
    const end=bot.entity.position;
    const d=Math.hypot(end.x-goal.x,end.z-goal.z);
    console.log(`  ${label}: ${code} ${((Date.now()-t0)/1000).toFixed(1)}s 最高升高${(maxY-s.y).toFixed(1)}格 上升${climbs}次 距目标${d.toFixed(1)}格 ${msg}`);
    try{bot.pathfinder.stop();}catch{}
    await sleep(600);
    return {code,dy:maxY-s.y,climbs,d};
  };

  const noVineClimb=(m)=>{
    for(const n of ['vine','weeping_vines','twisting_vines','cave_vines','weeping_vines_plant','twisting_vines_plant','cave_vines_plant']){
      const def=bot.registry.blocksByName[n]; if(def) m.climbables.delete(def.id);
    }
  };

  // 目标：柱子西侧（要穿过柱子所在格 or 绕过）
  const goal={x:VX-4, y:68, z:VZ};
  console.log('\n=== 目标：藤蔓柱西侧 4 格 ===');
  const A=await runCase('A 默认    ', ()=>{}, goal);
  const B=await runCase('B 移除攀爬', noVineClimb, goal);

  console.log('\n=== 目标：藤蔓柱正上方（模拟"目标树的树冠/树干高处"） ===');
  const goalTop={x:VX, y:74, z:VZ};
  const C=await runCase('C 默认    ', ()=>{}, goalTop);
  const D=await runCase('D 移除攀爬', noVineClimb, goalTop);

  console.log('\n=== 判读 ===');
  console.log(`  穿柱: A升高${A.dy.toFixed(1)} ${A.code} / B升高${B.dy.toFixed(1)} ${B.code}`);
  console.log(`  上柱顶: C升高${C.dy.toFixed(1)} ${C.code} / D升高${D.dy.toFixed(1)} ${D.code}`);
  if(C.dy>2) console.log('  ★ 默认配置会沿藤蔓爬升');
  if(D.code==='OK' && D.dy<1) console.log('  ★ 移除后不再爬升');
  await RC('forceload remove all');
  bot.quit(); process.exit(0);
});
