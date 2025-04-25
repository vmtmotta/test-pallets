// app.js

// --- Pallet constraints ---
const PALLET_L      = 120;  // cm
const PALLET_W      =  80;  // cm
const PALLET_MAX_H  = 170;  // cm total stack height
const PALLET_MAX_WT = 600;  // kg including pallet
const PALLET_WT     =  25;  // kg empty pallet

let products = {};

window.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch(`products-detail.json?cb=${Date.now()}`);
    products = await res.json();
  } catch (e) {
    console.error('Error loading products-detail.json', e);
    alert('Could not load product master data.');
  }
});

document.getElementById('go').addEventListener('click', async () => {
  const customer = document.getElementById('customer').value.trim();
  const fileIn   = document.getElementById('fileInput');
  if (!customer || !fileIn.files.length) {
    return alert('Enter a customer name and select an Excel file.');
  }

  // 1) read workbook
  const buf = await fileIn.files[0].arrayBuffer();
  const wb  = XLSX.read(buf, { type:'array' });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const rows= XLSX.utils.sheet_to_json(ws, { header:1, raw:true, blankrows:false });

  // 2) find header
  const LABELS = ['REF','PRODUCT','BOX USED (BOX1 OR BOX2)','ORDER IN UNITS'];
  let hr=-1, ci={};
  for (let i=0; i<Math.min(rows.length,20); i++){
    const up = rows[i].map(c=>c!=null?c.toString().toUpperCase().trim():'');
    if (LABELS.every(l=>up.includes(l))){
      hr = i;
      ci = {
        REF:   up.indexOf('REF'),
        PROD:  up.indexOf('PRODUCT'),
        BOX:   up.indexOf('BOX USED (BOX1 OR BOX2)'),
        UNITS: up.indexOf('ORDER IN UNITS')
      };
      break;
    }
  }
  if (hr<0) {
    return alert('Could not find header row with REF / PRODUCT / BOX USED / ORDER IN UNITS.');
  }

  // 3) parse orders
  const orders = [];
  for (let i=hr+1; i<rows.length; i++){
    const r=rows[i], raw=r[ci.REF];
    if (raw==null||!raw.toString().trim()) break;
    const sku = raw.toString().trim();
    if (!products[sku]) continue;
    orders.push({
      sku,
      name:   (r[ci.PROD]||'').toString().trim()||sku,
      boxKey: (r[ci.BOX]||'').toString().trim().toLowerCase(),
      units:  Number(r[ci.UNITS])||0
    });
  }
  if (!orders.length) {
    return document.getElementById('output').innerHTML=
      '<p><em>No valid order lines found. Check your file.</em></p>';
  }

  // 4) expand into box‐instances
  let instances=[];
  orders.forEach(o=>{
    const pd = products[o.sku], spec=pd[o.boxKey];
    if (!spec||!spec.units) return;
    const cnt = Math.ceil(o.units/spec.units);
    const [L,D,H] = spec.dimensions;
    for(let k=0;k<cnt;k++){
      instances.push({
        sku:       o.sku,
        name:      o.name,
        fragility: pd.fragility.toLowerCase(),
        weight:    spec.weight,
        dims:      { l:L, w:D, h:H },
        canRotate: spec.orientation.toLowerCase()==='both'
      });
    }
  });
  if (!instances.length) {
    return document.getElementById('output').innerHTML=
      '<p><em>No boxes to pack after expansion.</em></p>';
  }

  // 5) sort by fragility
  const orderF={strong:0,medium:1,fragile:2};
  instances.sort((a,b)=>orderF[a.fragility]-orderF[b.fragility]);

  // 6) pack into pallets
  let remaining=instances.slice(), pallets=[];
  while(remaining.length){
    let usedH=0, usedWT=PALLET_WT;
    const pal={layers:[]};
    while(remaining.length){
      const {placed,notPlaced} = packLayer(remaining);
      if (!placed.length) break;
      const layerH  = Math.max(...placed.map(x=>x.box.dims.h));
      const layerWT = placed.reduce((s,x)=>s+x.box.weight,0);
      if (usedH+layerH>PALLET_MAX_H || usedWT+layerWT>PALLET_MAX_WT) break;
      pal.layers.push({boxes:placed,height:layerH,weight:layerWT});
      usedH  += layerH;
      usedWT += layerWT;
      remaining = notPlaced;
    }
    pallets.push(pal);
  }

  // 7) render output
  let html=`<h1>${customer}</h1>`,
      totBoxes=0, totUnits=0, totWT=0;

  pallets.forEach((p,pi)=>{
    html+=`<h2>PALLET ${pi+1}</h2>`;
    let pUnits=0, pBoxes=0, pWT=PALLET_WT, pH=0;
    p.layers.forEach((ly,li)=>{
      html+=`<h3>LAYER${li+1}</h3>
        <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;">
          <thead><tr>
            <th>SKU</th><th>Product</th><th>Units</th>
            <th>Box Type</th><th>Boxes Needed</th>
          </tr></thead><tbody>`;
      const cnt = {};
      ly.boxes.forEach(b=>cnt[b.box.sku]=(cnt[b.box.sku]||0)+1);
      for(const [sku,n] of Object.entries(cnt)){
        const o=orders.find(x=>x.sku===sku);
        const per=products[sku][o.boxKey].units;
        const u=per*n;
        html+=`<tr>
          <td>${sku}</td>
          <td>${o.name}</td>
          <td style="text-align:right">${u}</td>
          <td>${o.boxKey.toUpperCase()}</td>
          <td style="text-align:right">${n}</td>
        </tr>`;
        pUnits+=u;
        pBoxes+=n;
      }
      pWT+=ly.weight;
      pH +=ly.height;
      html+=`</tbody></table>`;
    });
    html+=`<p><strong>Summary pallet ${pi+1}:</strong>
      ${pUnits} units | ${pBoxes} Boxes |
      Total Weight: ${pWT.toFixed(1)} Kg |
      Total Height: ${pH} cm</p>`;
    totBoxes+=pBoxes; totUnits+=pUnits; totWT+=pWT;
  });

  html+=`<h2>ORDER RESUME:</h2>
    <p>Total Pallets: ${pallets.length}<br>
       Total Weight: ${totWT.toFixed(1)} Kg</p>`;

  document.getElementById('output').innerHTML=html;
});

// 2‐mode packLayer: if all same‐SKU & same dims, use fast “5+2” split
function packLayer(boxes){
  const first = boxes[0];
  const homogeneous = boxes.every(b=>
    b.sku===first.sku &&
    b.dims.l===first.dims.l &&
    b.dims.w===first.dims.w
  );
  if (homogeneous){
    return homogeneousPack(boxes);
  }
  return guillotinePack(boxes);
}

// fast 2‐row “5 across + rotated 2 across” for identical boxes
function homogeneousPack(boxes){
  const b = boxes[0];
  const opts = [
    { l:b.dims.l, w:b.dims.w },
    { l:b.dims.w, w:b.dims.l }
  ];
  // row1 picks orientation maximizing count
  let row1={count:-1,opt:null,h:0};
  opts.forEach(o=>{
    const cnt = Math.floor(PALLET_L/o.l);
    if (cnt>row1.count){
      row1={count:cnt,opt:o,h:o.w};
    }
  });
  // row2 fits in remaining width
  const remH = PALLET_W - row1.h;
  let row2={count:0,opt:null};
  opts.forEach(o=>{
    if (o.w<=remH){
      const cnt = Math.floor(PALLET_L/o.l);
      if (cnt>row2.count){
        row2={count:cnt,opt:o};
      }
    }
  });
  const placed=[];
  // place row1
  for(let i=0;i<row1.count;i++){
    placed.push({box:b,x:i*row1.opt.l,y:0,dims:row1.opt});
  }
  // place row2
  for(let i=0;i<row2.count;i++){
    placed.push({box:b,x:i*row2.opt.l,y:row1.h,dims:row2.opt});
  }
  return {
    placed,
    notPlaced: boxes.slice(row1.count + row2.count)
  };
}

// classic guillotine‐packing
function guillotinePack(boxes){
  const free=[{x:0,y:0,w:PALLET_L,h:PALLET_W}];
  const placed=[];
  let notPlaced=boxes.slice();
  boxes.forEach(b=>{
    const opts=[{l:b.dims.l,w:b.dims.w}];
    if (b.canRotate) opts.push({l:b.dims.w,w:b.dims.l});
    let fit=null;
    for(const slot of free){
      for(const d of opts){
        if (d.l<=slot.w && d.w<=slot.h){
          fit={slot,d}; break;
        }
      }
      if (fit) break;
    }
    if (!fit) return;
    placed.push({box:b,x:fit.slot.x,y:fit.slot.y,dims:fit.d});
    free.splice(free.indexOf(fit.slot),1);
    free.push(
      { x:fit.slot.x+fit.d.l, y:fit.slot.y,       w:fit.slot.w-fit.d.l, h:fit.d.w },
      { x:fit.slot.x,         y:fit.slot.y+fit.d.w, w:fit.slot.w,             h:fit.slot.h-fit.d.w }
    );
    notPlaced = notPlaced.filter(x=>x!==b);
  });
  return {placed, notPlaced};
}
