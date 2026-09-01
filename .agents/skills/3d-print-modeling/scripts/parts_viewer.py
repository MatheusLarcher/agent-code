#!/usr/bin/env python3
"""Self-contained multi-part STL viewer -> ONE parts_viewer.html (no server needed).

Bundles every STL in a directory as base64 into a single HTML the user opens by
double-click. Three.js loads from a CDN (needs internet once). Built for the
"part-by-part" workflow: many independent STLs you want to see together.

    python3 parts_viewer.py [stl_dir] [out.html]

Defaults: stl_dir = first of ./output/stl, ./stl, . ; out = ./parts_viewer.html

Features
  - Z-UP done right (camera up = +Z; do NOT rotate geometry to Y-up, see SKILL gotchas).
  - grid auto-layout (all parts spread on a bed grid) vs "in place" (modeled coords).
  - per-part show/hide, spin, fit, deterministic per-name colors.
  - CAD-style dimension lines on each bbox: X=length(red) Y=width(green) Z=height(blue).
  - OPTIONAL assembly view: if <stl_dir>/../assembly.json (or ./assembly.json) exists,
    an "assembly" button poses parts as a working assembly. Format:
        {"primary": {"<stl_name>": [16 floats col-major], ...},
         "extras":  [{"name":"<label>", "src":"<stl_name>", "asm":[16 floats]}]}
    Build the 4x4 in Python (T @ R) and pass M.flatten(order='F').tolist().
    The assembly button is hidden when no assembly.json is found.
"""
import base64
import glob
import json
import os
import sys

import trimesh


def find_dir(arg):
    if arg:
        return arg
    for d in ('output/stl', 'stl', '.'):
        if glob.glob(os.path.join(d, '*.stl')):
            return d
    return '.'


def load_assembly(stl_dir):
    for p in (os.path.join(stl_dir, '..', 'assembly.json'), 'assembly.json'):
        if os.path.exists(p):
            j = json.load(open(p))
            return j.get('primary', {}), j.get('extras', [])
    return {}, []


def collect(stl_dir):
    primary, extras = load_assembly(stl_dir)
    parts = []
    for path in sorted(glob.glob(os.path.join(stl_dir, '*.stl'))):
        name = os.path.splitext(os.path.basename(path))[0]
        b = open(path, 'rb').read()
        m = trimesh.load(path)
        size = (m.bounds[1] - m.bounds[0]).tolist()
        parts.append({'name': name, 'b64': base64.b64encode(b).decode(),
                      'size': [round(s, 1) for s in size], 'asm': primary.get(name)})
    return parts, extras


HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>Parts viewer</title>
<style>
 html,body{margin:0;height:100%;background:#15171c;color:#e8eaed;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;overflow:hidden}
 #ui{position:fixed;top:12px;left:12px;z-index:10;background:#20242bdd;border:1px solid #333a45;border-radius:12px;padding:14px 16px;max-width:330px;max-height:90vh;overflow:auto;backdrop-filter:blur(8px)}
 #ui b{font-size:15px}
 .row{display:flex;align-items:center;gap:8px;margin:5px 0}
 .sw{width:13px;height:13px;border-radius:3px;flex:0 0 auto}
 .dim{opacity:.5;font-size:11px;margin-left:auto}
 button{background:#2b313a;color:#e8eaed;border:1px solid #3a424e;border-radius:7px;padding:6px 10px;font:inherit;cursor:pointer}
 button:hover{border-color:#5a6678}
 button.on{background:#3a4a63;border-color:#5a83c0}
 label{cursor:pointer;user-select:none}
 #empty{opacity:.6;padding:20px 0}
 hr{border:0;border-top:1px solid #333a45;margin:10px 0}
 #legend{font-size:11px;opacity:.8;margin-top:8px}
 .dlabel{font:700 11px ui-monospace,Menlo,monospace;white-space:nowrap;padding:1px 6px;border-radius:5px;background:#12141999;border:1px solid #ffffff22}
</style></head><body>
<div id="ui">
 <b>Parts</b> <span id="count" style="opacity:.6"></span>
 <div class="row"><button id="assy" style="display:none">assembly</button><button id="layout" class="on">grid</button><button id="dims" class="on">dims</button><button id="spin">spin</button><button id="fit">fit</button></div>
 <div id="legend">dims: <span style="color:#ff8f8f">L=length(X)</span> · <span style="color:#86e29a">W=width(Y)</span> · <span style="color:#8fc8fb">H=height(Z)</span></div>
 <hr><div id="list"></div>
</div>
<script type="importmap">{"imports":{
 "three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
 "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {STLLoader} from 'three/addons/loaders/STLLoader.js';
import {CSS2DRenderer, CSS2DObject} from 'three/addons/renderers/CSS2DRenderer.js';
const PARTS=__PARTS__, EXTRAS=__EXTRAS__, geomByName={};
function hue(s){let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))>>>0;return h%360;}
const COLX=0xff6b6b,COLY=0x51cf66,COLZ=0x4dabf7,TXT={x:'#ff8f8f',y:'#86e29a',z:'#8fc8fb'};
const scene=new THREE.Scene();scene.background=new THREE.Color(0x15171c);
const cam=new THREE.PerspectiveCamera(45,innerWidth/innerHeight,1,50000);cam.up.set(0,0,1); // Z up
const rnd=new THREE.WebGLRenderer({antialias:true});rnd.outputColorSpace=THREE.SRGBColorSpace;
rnd.toneMapping=THREE.ACESFilmicToneMapping;rnd.toneMappingExposure=1.05;
rnd.setSize(innerWidth,innerHeight);rnd.setPixelRatio(devicePixelRatio);document.body.appendChild(rnd.domElement);
const labelRnd=new CSS2DRenderer();labelRnd.setSize(innerWidth,innerHeight);
labelRnd.domElement.style.cssText='position:absolute;top:0;left:0;pointer-events:none';document.body.appendChild(labelRnd.domElement);
scene.add(new THREE.HemisphereLight(0xffffff,0x33373d,1.1));
const d1=new THREE.DirectionalLight(0xffffff,1.7);d1.position.set(1,-1.4,2);scene.add(d1);
const d2=new THREE.DirectionalLight(0xffffff,.7);d2.position.set(-1.5,1,.6);scene.add(d2);
const ctr=new OrbitControls(cam,rnd.domElement);ctr.enableDamping=true;
const grid=new THREE.GridHelper(2000,40,0x2a2f38,0x23272e);grid.rotation.x=Math.PI/2;scene.add(grid); // XY ground for Z-up
const meshes=[];let gridMode=true,spinning=false,showDims=true,assembled=false;
const root=new THREE.Group();scene.add(root);const loader=new STLLoader();
function b64buf(b){return Uint8Array.from(atob(b),c=>c.charCodeAt(0)).buffer;}
function line(p1,p2,color){return new THREE.Line(new THREE.BufferGeometry().setFromPoints([p1,p2]),new THREE.LineBasicMaterial({color}));}
function tick(p,ax,len,color){const a=p.clone(),b=p.clone();a[ax]-=len/2;b[ax]+=len/2;return line(a,b,color);}
function label(t,css){const d=document.createElement('div');d.className='dlabel';d.textContent=t;d.style.color=css;d.style.borderColor=css+'66';return new CSS2DObject(d);}
const n=PARTS.length,cols=Math.max(1,Math.ceil(Math.sqrt(n)));
let cell=0;PARTS.forEach(p=>cell=Math.max(cell,p.size[0],p.size[1]));cell+=70;
PARTS.forEach((p,i)=>{
  const g=loader.parse(b64buf(p.b64));g.computeVertexNormals();geomByName[p.name]=g;
  g.computeBoundingBox();const bb=g.boundingBox,mn=bb.min,mx=bb.max,c=new THREE.Vector3();bb.getCenter(c);
  const sz=new THREE.Vector3();bb.getSize(sz);
  const m=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:new THREE.Color(`hsl(${hue(p.name)},48%,60%)`),metalness:.1,roughness:.62,side:THREE.DoubleSide}));
  const o=Math.max(8,sz.length()*0.04),D=new THREE.Group();
  D.add(line(new THREE.Vector3(mn.x,mn.y-o,mn.z),new THREE.Vector3(mx.x,mn.y-o,mn.z),COLX));
  D.add(tick(new THREE.Vector3(mn.x,mn.y-o,mn.z),'y',o*.5,COLX));D.add(tick(new THREE.Vector3(mx.x,mn.y-o,mn.z),'y',o*.5,COLX));
  let L=label('L '+sz.x.toFixed(0),TXT.x);L.position.set(c.x,mn.y-o,mn.z);D.add(L);
  D.add(line(new THREE.Vector3(mx.x+o,mn.y,mn.z),new THREE.Vector3(mx.x+o,mx.y,mn.z),COLY));
  D.add(tick(new THREE.Vector3(mx.x+o,mn.y,mn.z),'x',o*.5,COLY));D.add(tick(new THREE.Vector3(mx.x+o,mx.y,mn.z),'x',o*.5,COLY));
  let W=label('W '+sz.y.toFixed(0),TXT.y);W.position.set(mx.x+o,c.y,mn.z);D.add(W);
  D.add(line(new THREE.Vector3(mx.x+o,mn.y-o,mn.z),new THREE.Vector3(mx.x+o,mn.y-o,mx.z),COLZ));
  D.add(tick(new THREE.Vector3(mx.x+o,mn.y-o,mn.z),'x',o*.5,COLZ));D.add(tick(new THREE.Vector3(mx.x+o,mn.y-o,mx.z),'x',o*.5,COLZ));
  let H=label('H '+sz.z.toFixed(0),TXT.z);H.position.set(mx.x+o,mn.y-o,c.z);D.add(H);
  m.add(D);
  m.userData.native=new THREE.Vector3(0,0,-mn.z);
  const col=i%cols,rowi=Math.floor(i/cols),rows=Math.ceil(n/cols);
  m.userData.grid=new THREE.Vector3(col*cell-(cols-1)*cell/2-c.x,rowi*cell-(rows-1)*cell/2-c.y,-mn.z);
  root.add(m);meshes.push({mesh:m,part:p,dims:D,labels:[L,W,H],cb:null});
});
const extras=[];
EXTRAS.forEach(e=>{const g=geomByName[e.src];if(!g)return;
  const m=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:new THREE.Color(`hsl(${(hue(e.src)+35)%360},45%,58%)`),metalness:.1,roughness:.62,side:THREE.DoubleSide}));
  m.visible=false;m.userData.asm=e.asm;root.add(m);extras.push(m);});
function ghost(m,on){m.material.transparent=on;m.material.opacity=on?0.3:1.0;m.material.depthWrite=!on;}
function place(){
  meshes.forEach(it=>{const m=it.mesh;
    if(assembled&&it.part.asm){m.matrixAutoUpdate=false;m.matrix.fromArray(it.part.asm);}
    else{m.matrixAutoUpdate=true;m.position.copy(gridMode?m.userData.grid:m.userData.native);m.quaternion.identity();m.scale.set(1,1,1);m.updateMatrix();}
    ghost(m,assembled&&/bracket|jaw|housing|body/i.test(it.part.name));});
  extras.forEach(m=>{m.visible=assembled;if(assembled){m.matrixAutoUpdate=false;m.matrix.fromArray(m.userData.asm);ghost(m,true);}});
}
function applyDims(){meshes.forEach(it=>{const on=(it.cb?it.cb.checked:true)&&showDims&&!assembled;
  it.dims.visible=on;it.labels.forEach(l=>{l.visible=on;l.element.style.display=on?'':'none';});});}
function fit(){const box=new THREE.Box3().setFromObject(root);const s=box.getSize(new THREE.Vector3());const c=box.getCenter(new THREE.Vector3());const r=Math.max(s.length()/2,1);ctr.target.copy(c);cam.position.copy(c).add(new THREE.Vector3(r*1.1,-r*1.6,r*1.0));ctr.update();}
const list=document.getElementById('list');document.getElementById('count').textContent=`(${n})`;
if(n===0)list.innerHTML='<div id="empty">No STLs found. Build some parts first.</div>';
meshes.forEach(it=>{const row=document.createElement('div');row.className='row';
  const sw=document.createElement('span');sw.className='sw';sw.style.background=`hsl(${hue(it.part.name)},48%,60%)`;
  const cb=document.createElement('input');cb.type='checkbox';cb.checked=true;cb.onchange=()=>{it.mesh.visible=cb.checked;applyDims();};it.cb=cb;
  const lb=document.createElement('label');lb.textContent=it.part.name;
  const dm=document.createElement('span');dm.className='dim';dm.textContent=it.part.size.join('×');
  row.append(sw,cb,lb,dm);list.appendChild(row);});
const bDims=document.getElementById('dims'),bAssy=document.getElementById('assy');
if(EXTRAS.length||PARTS.some(p=>p.asm))bAssy.style.display='';
bAssy.onclick=()=>{assembled=!assembled;bAssy.classList.toggle('on',assembled);place();applyDims();fit();};
document.getElementById('layout').onclick=e=>{gridMode=!gridMode;e.target.textContent=gridMode?'grid':'in place';e.target.classList.toggle('on',gridMode);place();fit();};
bDims.onclick=()=>{showDims=!showDims;bDims.classList.toggle('on',showDims);applyDims();};
document.getElementById('spin').onclick=e=>{spinning=!spinning;e.target.classList.toggle('on',spinning);};
document.getElementById('fit').onclick=fit;
addEventListener('resize',()=>{cam.aspect=innerWidth/innerHeight;cam.updateProjectionMatrix();rnd.setSize(innerWidth,innerHeight);labelRnd.setSize(innerWidth,innerHeight);});
place();applyDims();fit();
(function loop(){requestAnimationFrame(loop);if(spinning)root.rotation.z+=.005;ctr.update();rnd.render(scene,cam);labelRnd.render(scene,cam);})();
</script></body></html>"""


def main():
    stl_dir = find_dir(sys.argv[1] if len(sys.argv) > 1 else None)
    out = sys.argv[2] if len(sys.argv) > 2 else 'parts_viewer.html'
    parts, extras = collect(stl_dir)
    html = HTML.replace('__PARTS__', json.dumps(parts)).replace('__EXTRAS__', json.dumps(extras))
    open(out, 'w').write(html)
    print(f'wrote {out}  ({len(html)/1024:.0f} KB, {len(parts)} part(s) from {stl_dir}/'
          + (f', assembly: {len(extras)} extra(s)' if (extras or any(p.get("asm") for p in parts)) else '') + ')')


if __name__ == '__main__':
    main()
