/* probe-eye-bones.js — 探测官方骨架里眼球与高光的父子关系。
 *
 * 为什么先探测：AgentAtelierR 记录过「程序化注视会把虹膜挪走、高光留下」的问题，
 * 但那取决于**这两个网格绑在骨骼树的哪一层**。本项目用 control_aim_eye 驱动注视，
 * 高光是否跟着走、要不要保位，必须先看真实的父子链，不能照抄结论。
 *
 * 用法: 起 serve.py 后 node scripts/probe-eye-bones.js
 */
'use strict';
const { puppeteer } = require('./_probe_env');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    defaultViewport: { width: 440, height: 900 }
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'load', timeout: 40000 });
  await sleep(3000);
  /* 直接加载皮肤骨架做静态分析，不依赖 UI 流程 */
  const results = [];
  for (let i = 0; i < 6; i++) {
    const info = await page.evaluate((idx) => {
      window.__probeIdx = idx;
    return new Promise(res => {
      const SKINS = ['crf_skn_002_0001_01','crf_skn_002_0001_99','crf_skn_002_0002_01',
                     'crf_skn_002_0003_01','crf_skn_002_0004_01','crf_skn_002_0005_01'];
      const id = SKINS[(window.__probeIdx = (window.__probeIdx || 0))] || SKINS[0];
      const a = new spine.AssetManager(Avatar.host.ctx);
      a.loadBinary('assets/spine/crf_chr_002/' + id + '/' + id + '.skel');
      a.loadTextureAtlas('assets/spine/crf_chr_002/' + id + '/' + id + '.atlas');
      window.__probeId = id;
      const poll = () => {
        if (!a.isLoadingComplete()) return setTimeout(poll, 100);
        try {
          const id2 = window.__probeId;
          const atlas = a.require('assets/spine/crf_chr_002/' + id2 + '/' + id2 + '.atlas');
          const bin = new spine.SkeletonBinary(new spine.AtlasAttachmentLoader(atlas));
          const data = bin.readSkeletonData(a.require('assets/spine/crf_chr_002/' + id2 + '/' + id2 + '.skel'));
          const chain = name => {
            let b = data.findBone(name);
            if (!b) return null;
            const out = [];
            while (b) { out.push(b.name); b = b.parent; }
            return out;
          };
          const all = data.bones.map(b => b.name).filter(n => /eyeball|eyehilight|hilight|aim_eye/i.test(n));
          /* 全部槽位：找出绑到 eyeball_*_offset / eyehilight_* 骨头上的那些 */
          const slots = data.slots.map(s => ({ slot: s.name, bone: s.boneData ? s.boneData.name : null }));
          const eyeSlots = slots.filter(s => /eyeball|eyehilight|hilight|eye/i.test(s.slot) ||
                                             (s.bone && /eyeball|hilight/i.test(s.bone)));
          const onOffsetBones = slots.filter(s => s.bone && /offset|hilight/i.test(s.bone));
          /* 这些骨骼各自的父链，用来看高光是否独立于虹膜 */
          const deepChain = name => {
            let b = data.findBone(name); if (!b) return null;
            const out = []; while (b) { out.push(b.name); b = b.parent; } return out;
          };
          return res({
            aimEyeChain: chain('control_aim_eye'),
            eyeballLChain: chain('_face_eyeball_L'),
            hilightLChain: chain('_face_eyehilight_L'),
            hilightRChain: chain('_face_eyehilight_R'),
            boneNames: all,
            eyeSlots: eyeSlots,
            slotsOnOffsetBones: onOffsetBones,
            offsetChain: deepChain('eyeball_L_offset'),
            hilightChain: deepChain('eyehilight_L'),
            faceEyeLChain: deepChain('face_eyeL')
          });
        } catch (e) { res({ error: e.message }); }
      };
      poll();
    });
    }, i);
    results.push(info);
  }
  const info = { skins: results };
  console.log(JSON.stringify(info, null, 1));
  if (errs.length) console.log('errors: ' + errs.slice(0, 3).join(' | '));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
