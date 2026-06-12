import { useState, useRef, useEffect } from "react";

const PAL=["#FF6B35","#00C8C8","#45B7D1","#96CEB4","#FFD93D","#C39BD3","#F1948A","#82E0AA","#F8B400","#1ABC9C","#E74C3C","#9B59B6"];
const N=v=>{const n=parseFloat(v);return isNaN(n)?0:n;};
const INF=1e8;

// ═══════════════════════════════════════════════════════════
//  DETECÇÃO DE DIMENSÕES — corrigida
// ═══════════════════════════════════════════════════════════

// SVG: converte unidades reais (mm, cm, in, pt, px) para mm
function svgPhysicalSize(txt) {
  const toMM = { mm:1, cm:10, in:25.4, pt:0.352778, px:0.264583 };
  const wm = txt.match(/\bwidth=["']\s*([0-9.]+)\s*(mm|cm|in|pt|px)?\s*["']/i);
  const hm = txt.match(/\bheight=["']\s*([0-9.]+)\s*(mm|cm|in|pt|px)?\s*["']/i);
  if (wm && hm) {
    const fw = toMM[(wm[2]||'px').toLowerCase()] ?? 0.264583;
    const fh = toMM[(hm[2]||'px').toLowerCase()] ?? 0.264583;
    const w = parseFloat(wm[1]) * fw;
    const h = parseFloat(hm[1]) * fh;
    if (w > 0 && h > 0) return { w, h };
  }
  // fallback: viewBox (coordenadas SVG = px a 96dpi por padrão CSS)
  const vb = txt.match(/viewBox=["']\s*([^"']+)\s*["']/i);
  if (vb) {
    const p = vb[1].trim().split(/[\s,]+/);
    if (p.length === 4) {
      const w = parseFloat(p[2]) * 0.264583;
      const h = parseFloat(p[3]) * 0.264583;
      if (w > 0 && h > 0) return { w, h };
    }
  }
  return null;
}

// SVG: extrai viewBox e conteúdo interno
function svgParts(raw, fallW, fallH) {
  const vm = raw.match(/viewBox=["']([^"']+)["']/i);
  const vb = vm ? vm[1] : `0 0 ${fallW} ${fallH}`;
  const inner = raw
    .replace(/<\?xml[^?]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/[\s\S]*?<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '');
  return { vb, inner };
}

// PNG/JPEG: lê DPI real dos bytes do arquivo (JFIF APP0 / PNG pHYs)
// Sem conversão assumida — usa o que está gravado no arquivo
async function readImageDPI(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const buf = e.target.result;
      const v = new DataView(buf);
      try {
        // ── JPEG: procura APP0 JFIF ───────────────────────
        if (v.byteLength > 4 && v.getUint16(0, false) === 0xFFD8) {
          let off = 2;
          while (off + 4 < v.byteLength) {
            const marker = v.getUint16(off, false);
            if (marker === 0xFFDA) break; // início dos dados — para
            const segLen = v.getUint16(off + 2, false);
            if (marker === 0xFFE0 && segLen >= 16) {
              // Lê identificador JFIF\0
              const sig = String.fromCharCode(
                v.getUint8(off+4), v.getUint8(off+5),
                v.getUint8(off+6), v.getUint8(off+7), v.getUint8(off+8)
              );
              if (sig === 'JFIF\0') {
                const unit = v.getUint8(off + 11);
                const xd   = v.getUint16(off + 12, false);
                const yd   = v.getUint16(off + 14, false);
                if (unit === 1 && xd > 1) // pixels por polegada
                  return resolve({ x: xd, y: yd || xd });
                if (unit === 2 && xd > 1) // pixels por cm → converte
                  return resolve({ x: Math.round(xd*2.54), y: Math.round((yd||xd)*2.54) });
              }
            }
            off += 2 + segLen;
          }
        }
        // ── PNG: procura chunk pHYs ───────────────────────
        if (v.byteLength > 8 && v.getUint32(0, false) === 0x89504E47) {
          let off = 8;
          while (off + 12 < v.byteLength) {
            const len  = v.getUint32(off, false);
            const type = String.fromCharCode(
              v.getUint8(off+4), v.getUint8(off+5),
              v.getUint8(off+6), v.getUint8(off+7)
            );
            if (type === 'pHYs' && len >= 9) {
              const x    = v.getUint32(off + 8, false);
              const y    = v.getUint32(off + 12, false);
              const unit = v.getUint8(off + 16);
              if (unit === 1 && x > 1) // pixels por metro → converte para DPI
                return resolve({ x: Math.round(x*0.0254), y: Math.round((y||x)*0.0254) });
            }
            if (type === 'IDAT') break;
            off += 12 + len;
          }
        }
      } catch (_) {}
      resolve(null); // DPI não encontrado no arquivo
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file.slice(0, 65536)); // primeiros 64 KB são suficientes
  });
}

// Dimensões em pixels da imagem (para exibir hint ao usuário)
const imgPxSize = url => new Promise(ok => {
  const i = new Image();
  i.onload = () => ok({ w: i.naturalWidth, h: i.naturalHeight });
  i.onerror = () => ok(null);
  i.src = url;
});

const readURL = f => new Promise((ok, er) => {
  const r = new FileReader();
  r.onload = e => ok(e.target.result);
  r.onerror = er;
  r.readAsDataURL(f);
});

// ═══════════════════════════════════════════════════════════
//  MAXRECTS (Mínimo Aumento de Altura + multi-pass)
// ═══════════════════════════════════════════════════════════
function overlaps(ax,ay,aw,ah,bx,by,bw,bh){return ax<bx+bw&&ax+aw>bx&&ay<by+bh&&ay+ah>by;}
function splitRect(fr,px,py,pw,ph){
  const c=[];
  if(px>fr.x)          c.push({x:fr.x,  y:fr.y, w:px-fr.x,         h:fr.h});
  if(px+pw<fr.x+fr.w)  c.push({x:px+pw, y:fr.y, w:fr.x+fr.w-px-pw, h:fr.h});
  if(py>fr.y)          c.push({x:fr.x,  y:fr.y, w:fr.w,             h:py-fr.y});
  const th=fr.h===INF?INF:fr.y+fr.h-py-ph;
  if(th>0) c.push({x:fr.x, y:py+ph, w:fr.w, h:th});
  return c;
}
function prune(rs){
  return rs.filter((r,i)=>{
    if(r.w<=0||r.h<=0) return false;
    for(let j=0;j<rs.length;j++){
      if(i===j) continue;
      const s=rs[j]; if(s.w<=0||s.h<=0) continue;
      const st=s.h===INF?INF:s.y+s.h, rt=r.h===INF?INF:r.y+r.h;
      if(s.x<=r.x&&s.y<=r.y&&s.x+s.w>=r.x+r.w&&st>=rt) return false;
    }
    return true;
  });
}
function maxRectsCore(items, binW, buf, allowRot) {
  let free=[{x:0,y:0,w:binW,h:INF}];
  const placed=[];
  let curMaxY=0;
  function bestFit(fw,fh){
    let best=null,b1=INF,b2=INF;
    for(const r of free){
      if(fw<=r.w&&fh<=r.h){
        const hi=Math.max(0,r.y+fh-curMaxY),lw=r.w-fw;
        if(hi<b1||(hi===b1&&lw<b2)){b1=hi;b2=lw;best=r;}
      }
    }
    return best?{rect:best,s1:b1,s2:b2}:null;
  }
  for(const item of items){
    const iw=N(item.w),ih=N(item.h); if(iw<=0||ih<=0) continue;
    const fw=iw+buf,fh=ih+buf,rw=ih+buf,rh=iw+buf;
    let ch=null,cW=iw,cH=ih,cRot=false;
    const n=bestFit(fw,fh); if(n) ch={rect:n.rect,s1:n.s1,s2:n.s2};
    if(allowRot&&iw!==ih){
      const rot=bestFit(rw,rh);
      if(rot&&(!ch||rot.s1<ch.s1||(rot.s1===ch.s1&&rot.s2<ch.s2))){
        ch={rect:rot.rect,s1:rot.s1,s2:rot.s2}; cW=ih; cH=iw; cRot=true;
      } else if(n){ cW=iw; cH=ih; cRot=false; }
    }
    if(!ch) continue;
    const rx=ch.rect.x, ry=ch.rect.y;
    placed.push({...item, x:rx+buf/2, y:ry+buf/2, w:cW, h:cH, rotated:cRot, origW:iw, origH:ih});
    curMaxY=Math.max(curMaxY, ry+cH+buf);
    const uw=cW+buf, uh=cH+buf, nf=[];
    for(const fr of free){
      if(!overlaps(fr.x,fr.y,fr.w,fr.h,rx,ry,uw,uh)){ nf.push(fr); continue; }
      nf.push(...splitRect(fr,rx,ry,uw,uh));
    }
    free=prune(nf);
  }
  const totalH=placed.length ? placed.reduce((m,p)=>Math.max(m,p.y+N(p.h)),0)+buf/2 : 0;
  return {placed, totalH};
}
function expand(pieces){
  const o=[];
  pieces.forEach((p,pi)=>{
    const q=Math.max(1,parseInt(p.qty)||1);
    for(let i=0;i<q;i++) o.push({...p,iid:`${p.id}-${i}`,idx:i,color:PAL[pi%PAL.length]});
  });
  return o;
}
function nest(pieces,usableW,buf,rot,byClient){
  const exp=expand(pieces); if(!exp.length) return{placed:[],totalH:0};
  const A=p=>N(p.w)*N(p.h), P=p=>N(p.w)+N(p.h), M=p=>Math.max(N(p.w),N(p.h));
  const orders=byClient
    ?[(a,b)=>a.client.localeCompare(b.client)||A(b)-A(a),(a,b)=>a.client.localeCompare(b.client)||M(b)-M(a)]
    :[(a,b)=>A(b)-A(a),(a,b)=>N(b.h)-N(a.h),(a,b)=>N(b.w)-N(a.w),(a,b)=>P(b)-P(a),(a,b)=>M(b)-M(a),(a,b)=>A(a)-A(b)];
  let best=null, bu=-1;
  for(const s of orders){
    const r=maxRectsCore([...exp].sort(s), usableW, buf, rot);
    const u=r.totalH>0 ? r.placed.reduce((x,p)=>x+N(p.w)*N(p.h),0)/(usableW*r.totalH) : -1;
    if(u>bu){ bu=u; best=r; }
  }
  return best;
}
function calcStats(placed,usableW,totalH){
  const u=placed.reduce((s,p)=>s+N(p.w)*N(p.h),0), t=usableW*totalH;
  return{util:t>0?u/t*100:0, waste:t>0?(t-u)/t*100:100, lm:totalH/1000, t, u};
}

// ═══════════════════════════════════════════════════════════
//  EXPORT SVG
// ═══════════════════════════════════════════════════════════

// Renderiza uma arte no SVG de exportação
function renderArtwork(p, vx, vy, pw, ph, buf, includeInfo, color) {
  let out = '';
  // ── Arte ──────────────────────────────────────────────
  if (p.svgRaw) {
    const {vb, inner} = svgParts(p.svgRaw, p.origW||pw, p.origH||ph);
    if (p.rotated) {
      out += `<g transform="translate(${vx},${vy+ph}) rotate(-90)">
  <svg x="0" y="0" width="${ph}" height="${pw}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" overflow="hidden">${inner}</svg>
</g>\n`;
    } else {
      out += `<svg x="${vx}" y="${vy}" width="${pw}" height="${ph}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" overflow="hidden">${inner}</svg>\n`;
    }
  } else if (p.imageDataURL) {
    if (p.rotated) {
      out += `<g transform="translate(${vx},${vy+ph}) rotate(-90)">
  <image xlink:href="${p.imageDataURL}" href="${p.imageDataURL}" x="0" y="0" width="${ph}" height="${pw}" preserveAspectRatio="xMidYMid meet"/>
</g>\n`;
    } else {
      out += `<image xlink:href="${p.imageDataURL}" href="${p.imageDataURL}" x="${vx}" y="${vy}" width="${pw}" height="${ph}" preserveAspectRatio="xMidYMid meet"/>\n`;
    }
  } else if (includeInfo) {
    out += `<rect x="${vx}" y="${vy}" width="${pw}" height="${ph}" fill="${color}22" stroke="${color}" stroke-width="0.5"/>\n`;
  }

  if (includeInfo) {
    // Informações visíveis apenas no SVG Layout
    const fs = Math.min(6, Math.max(2, Math.min(pw/7, ph/3.5)));
    const lb = `${p.label}${parseInt(p.qty)>1?` #${p.idx+1}`:''}${p.rotated?' ↻':''}`;
    out += `<rect x="${vx-buf/2}" y="${vy-buf/2}" width="${pw+buf}" height="${ph+buf}" fill="none" stroke="${color}" stroke-width="0.2" stroke-dasharray="1.5,1.5" opacity="0.35"/>\n`;
    out += `<rect x="${vx}" y="${vy}" width="${pw}" height="${ph}" fill="none" stroke="${color}" stroke-width="0.5" rx="0.3"/>\n`;
    out += `<text x="${vx+pw/2}" y="${vy+ph/2-fs*.4}" text-anchor="middle" font-size="${fs}" font-family="monospace" font-weight="bold" fill="${color}">${lb}</text>\n`;
    if(pw>10&&ph>8) out+=`<text x="${vx+pw/2}" y="${vy+ph/2+fs*.9}" text-anchor="middle" font-size="${fs*.78}" font-family="monospace" fill="#555">${pw.toFixed(1)}x${ph.toFixed(1)}mm</text>\n`;
    if(pw>14&&ph>10) out+=`<text x="${vx+1}" y="${vy+ph-1.2}" font-size="${Math.max(1.5,fs*.6)}" font-family="monospace" fill="#999">X${p.x.toFixed(0)} Y${vy.toFixed(0)}</text>\n`;
  } else {
    // SVG com artes: apenas hairline de registro (0.1pt — padrão de corte)
    out += `<rect x="${vx}" y="${vy}" width="${pw}" height="${ph}" fill="none" stroke="#000" stroke-width="0.1"/>\n`;
  }
  return out;
}

function buildSVGBase(placed, totalH, rollW, usableW, pinch, buf, title, includeInfo) {
  const PAD = includeInfo ? 15 : 5;
  const W = rollW + PAD*2;
  const H = totalH + PAD*2 + (includeInfo ? 14 : 0);
  let grid='', rulerX='', rulerY='', pieces='';

  if (includeInfo) {
    for(let x=0;x<=usableW;x+=50) grid+=`<line x1="${x+pinch}" y1="0" x2="${x+pinch}" y2="${totalH}" stroke="#eee" stroke-width="0.25"/>`;
    for(let y=0;y<=totalH;y+=50) grid+=`<line x1="0" y1="${y}" x2="${rollW}" y2="${y}" stroke="#eee" stroke-width="0.25"/>`;
    for(let x=0;x<=rollW;x+=50){
      rulerX+=`<line x1="${x+PAD}" y1="${PAD+totalH}" x2="${x+PAD}" y2="${PAD+totalH+3}" stroke="#aaa" stroke-width="0.4"/>`;
      rulerX+=`<text x="${x+PAD}" y="${PAD+totalH+8}" text-anchor="middle" font-size="3" font-family="monospace" fill="#888">${x}</text>`;
    }
    for(let y=0;y<=totalH;y+=50){
      rulerY+=`<line x1="${PAD-1}" y1="${y+PAD}" x2="${PAD+1}" y2="${y+PAD}" stroke="#aaa" stroke-width="0.4"/>`;
      rulerY+=`<text x="${PAD-2}" y="${y+PAD+1.2}" text-anchor="end" font-size="3" font-family="monospace" fill="#888">${y}</text>`;
    }
  }

  placed.forEach(p => {
    const pw=N(p.w), ph=N(p.h), vx=p.x+pinch, vy=p.y;
    pieces += renderArtwork(p, vx, vy, pw, ph, buf, includeInfo, p.color);
  });

  const header = includeInfo
    ? `<rect width="${W}" height="${H}" fill="white"/>
  <text x="${PAD}" y="6" font-size="3.5" font-family="monospace" font-weight="bold" fill="#333">NESTCUT — ${title}</text>
  <text x="${PAD}" y="11" font-size="2.8" font-family="monospace" fill="#666">Rolo:${rollW}mm Util:${usableW}mm Pinca:${pinch}mm Buffer:${buf}mm | ${placed.length} pecas | ${totalH.toFixed(0)}mm = ${(totalH/1000).toFixed(3)}m</text>`
    : `<rect width="${W}" height="${H}" fill="white"/>`;

  const borders = includeInfo
    ? `<rect x="0" y="0" width="${rollW}" height="${totalH}" fill="#fafafa" stroke="#ccc" stroke-width="0.5"/>
    ${grid}
    <rect x="0" y="0" width="${pinch}" height="${totalH}" fill="rgba(220,30,30,0.05)" stroke="rgba(220,30,30,0.3)" stroke-width="0.4" stroke-dasharray="3,2"/>
    <rect x="${rollW-pinch}" y="0" width="${pinch}" height="${totalH}" fill="rgba(220,30,30,0.05)" stroke="rgba(220,30,30,0.3)" stroke-width="0.4" stroke-dasharray="3,2"/>
    <rect x="${pinch}" y="0" width="${usableW}" height="${totalH}" fill="none" stroke="#3a80cc" stroke-width="0.4" stroke-dasharray="4,4"/>`
    : `<rect x="0" y="0" width="${rollW}" height="${totalH}" fill="white" stroke="#ccc" stroke-width="0.3"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">
  <!-- NESTCUT | ${title} | ${rollW}x${totalH.toFixed(0)}mm | ${placed.length} pecas -->
  ${header}
  <g transform="translate(${PAD},${PAD})">
    ${borders}
    ${pieces}
  </g>
  ${rulerX}${rulerY}
</svg>`;
}

// Export com artes: limpo, sem texto, só artwork + hairline
const makeSVGFull   = (pl,tH,rW,uW,pi,buf,title) => buildSVGBase(pl,tH,rW,uW,pi,buf,title,false);
// Export layout: todas as informações
const makeSVGLayout = (pl,tH,rW,uW,pi,buf,title) => buildSVGBase(pl,tH,rW,uW,pi,buf,title,true);

function dlSVG(str,name){
  const b=new Blob([str],{type:'image/svg+xml;charset=utf-8'}),u=URL.createObjectURL(b),a=document.createElement('a');
  a.href=u; a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(u),1500);
}

// ═══════════════════════════════════════════════════════════
//  CANVAS PREVIEW
// ═══════════════════════════════════════════════════════════
function PieceImage({dataURL,px,py,sw,sh,rotated}){
  if(!dataURL||sw<4||sh<4) return null;
  if(!rotated) return <image href={dataURL} x={px} y={py} width={sw} height={sh} preserveAspectRatio="xMidYMid meet" opacity={0.92}/>;
  return(
    <g transform={`translate(${px},${py+sh}) rotate(-90)`}>
      <image href={dataURL} x={0} y={0} width={sh} height={sw} preserveAspectRatio="xMidYMid meet" opacity={0.92}/>
    </g>
  );
}
function Canvas({placed,totalH,rollW,usableW,pinch,buf}){
  const ref=useRef(),[cw,setCw]=useState(600);
  useEffect(()=>{
    const o=new ResizeObserver(e=>setCw(Math.max(200,e[0].contentRect.width-2)));
    if(ref.current)o.observe(ref.current); return()=>o.disconnect();
  },[]);
  if(!totalH||!placed.length) return <div ref={ref} style={{flex:1}}/>;
  const sc=cw/rollW, svgH=totalH*sc, s=v=>v*sc;
  const xt=[], step=totalH>800?200:totalH>400?100:totalH>150?50:25, yt=[];
  for(let x=0;x<=rollW;x+=50) xt.push(x);
  for(let y=0;y<=totalH;y+=step) yt.push(y);
  return(
    <div ref={ref} style={{width:'100%',overflowY:'auto',flex:1}}>
      <svg width={cw} height={svgH+28} style={{display:'block',background:'#070c14'}}>
        <defs>
          <pattern id="g10" width={s(10)} height={s(10)} patternUnits="userSpaceOnUse">
            <path d={`M${s(10)} 0L0 0 0 ${s(10)}`} fill="none" stroke="#0d1620" strokeWidth={0.5}/>
          </pattern>
          <pattern id="g50" width={s(50)} height={s(50)} patternUnits="userSpaceOnUse">
            <rect width={s(50)} height={s(50)} fill="url(#g10)"/>
            <path d={`M${s(50)} 0L0 0 0 ${s(50)}`} fill="none" stroke="#142030" strokeWidth={1}/>
          </pattern>
        </defs>
        <rect width={cw} height={svgH} fill="url(#g50)"/>
        <rect width={cw} height={svgH} fill="none" stroke="#1e3050" strokeWidth={2}/>
        {[0,s(rollW-pinch)].map((px,i)=>(
          <rect key={i} x={px} y={0} width={s(pinch)} height={svgH}
            fill="rgba(255,60,60,0.07)" stroke="rgba(255,80,80,0.4)" strokeWidth={1} strokeDasharray="6,4"/>
        ))}
        <rect x={s(pinch)} y={0} width={s(usableW)} height={svgH}
          fill="none" stroke="#2060cc" strokeWidth={0.8} strokeDasharray="4,6" opacity={0.5}/>
        {placed.map(p=>{
          const pw=N(p.w),ph=N(p.h),px=s(p.x+pinch),py=s(p.y),sw=s(pw),sh=s(ph),col=p.color;
          const fs=Math.max(7,Math.min(13,sw/6,sh/2.5));
          const lb=`${p.label}${parseInt(p.qty)>1?` #${p.idx+1}`:''}`;
          return(
            <g key={p.iid}>
              <rect x={px-s(buf/2)} y={py-s(buf/2)} width={sw+s(buf)} height={sh+s(buf)}
                fill="none" stroke={col} strokeWidth={0.6} strokeDasharray="2,2" opacity={0.22} rx={2}/>
              <rect x={px} y={py} width={sw} height={sh}
                fill={p.imageDataURL?'none':col+'28'} stroke={col} strokeWidth={1.5} rx={2}/>
              <PieceImage dataURL={p.imageDataURL} px={px} py={py} sw={sw} sh={sh} rotated={p.rotated}/>
              {!p.imageDataURL&&<rect x={px} y={py} width={sw} height={sh} fill={col+'28'} rx={2}/>}
              {sw>18&&sh>11&&<text x={px+sw/2} y={py+sh/2} textAnchor="middle" dominantBaseline="middle"
                fontSize={Math.min(fs,sw/5)} fontFamily="monospace" fontWeight="bold"
                fill="white" stroke="#000b" strokeWidth={3} paintOrder="stroke">{lb}</text>}
              {sw>32&&sh>s(20)&&<text x={px+sw/2} y={py+sh/2+Math.min(fs,sw/5)+5} textAnchor="middle"
                fontSize={Math.min(fs*.72,sw/7)} fontFamily="monospace"
                fill="rgba(255,255,255,0.55)" stroke="#000a" strokeWidth={2.5} paintOrder="stroke">
                {pw.toFixed(0)}x{ph.toFixed(0)}mm{p.rotated?' ↻':''}
              </text>}
              {sw>44&&sh>s(18)&&<text x={px+2} y={py+sh-3} fontSize={Math.min(7,sw/10)}
                fontFamily="monospace" fill="rgba(255,255,255,0.35)">X{p.x.toFixed(0)} Y{p.y.toFixed(0)}</text>}
            </g>
          );
        })}
        {xt.map(v=>(
          <g key={v}>
            <line x1={s(v)} y1={svgH} x2={s(v)} y2={svgH+5} stroke="#3a5570" strokeWidth={0.8}/>
            <text x={s(v)} y={svgH+14} textAnchor="middle" fill="#3a5570" fontSize={9} fontFamily="monospace">{v}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  COMPONENTES UI
// ═══════════════════════════════════════════════════════════
function Num({value,onChange,style,ph='0'}){
  const[raw,setRaw]=useState(value===0?'':String(value??''));
  const ext=useRef(value);
  if(value!==ext.current){ext.current=value;setRaw(value===0?'':String(value));}
  return(
    <input type="text" inputMode="decimal" placeholder={ph} value={raw} style={style}
      onFocus={e=>e.target.select()}
      onChange={e=>{const v=e.target.value;if(v===''||/^\d*\.?\d*$/.test(v)){setRaw(v);const n=parseFloat(v);onChange(isNaN(n)?0:n);}}}
      onBlur={()=>{const n=parseFloat(raw),f=isNaN(n)?0:n;setRaw(f===0?'':String(f));onChange(f);}}/>
  );
}

function Uploader({piece,onUpdate}){
  const ref=useRef();
  const go=async f=>{
    if(!f) return;
    const isSVG=f.type==='image/svg+xml'||f.name.toLowerCase().endsWith('.svg');
    try{
      const url=await readURL(f);
      let dw=0, dh=0, svgRaw=null, hint='';

      if(isSVG){
        // SVG: lê unidades reais (mm/cm/in/pt/px)
        const txt=await f.text();
        svgRaw=txt;
        const d=svgPhysicalSize(txt);
        if(d){ dw=Math.round(d.w*10)/10; dh=Math.round(d.h*10)/10; }

      } else {
        // Raster: lê DPI do cabeçalho do arquivo
        const [dpi, dims]=await Promise.all([readImageDPI(f), imgPxSize(url)]);
        if(dims){
          if(dpi && dpi.x>1){
            // Converte pixels → mm usando DPI real do arquivo
            dw=Math.round(dims.w/dpi.x*254)/10;
            dh=Math.round(dims.h/dpi.y*254)/10;
            hint=`${dims.w}×${dims.h}px @ ${dpi.x}dpi`;
          } else {
            // DPI desconhecido — não preenche, usuário insere manualmente
            dw=0; dh=0;
            hint=`${dims.w}×${dims.h}px — DPI não encontrado, insira as dimensões`;
          }
        }
      }

      onUpdate({
        imageDataURL:url, imageName:f.name, svgRaw,
        w: dw||piece.w, h: dh||piece.h, hint
      });
    }catch(e){console.error(e);}
  };

  const C={gr:'#3fb950',bord:'#1a2d42',mut:'#304860',dim:'#1e3045'};
  const isSVGfile=piece.imageName?.toLowerCase().endsWith('.svg');

  return(
    <div>
      <div onClick={()=>ref.current.click()} onDragOver={e=>e.preventDefault()}
        onDrop={e=>{e.preventDefault();go(e.dataTransfer.files[0]);}}
        style={{border:`1.5px dashed ${piece.imageDataURL?C.gr:C.bord}`,borderRadius:6,
          padding:'7px 5px',cursor:'pointer',textAlign:'center',
          background:piece.imageDataURL?'#091a10':'#06101c',
          marginBottom:piece.hint?4:8,minHeight:52,display:'flex',alignItems:'center',
          justifyContent:'center',flexDirection:'column',gap:2}}>
        <input ref={ref} type="file" accept=".svg,.png,.jpg,.jpeg" style={{display:'none'}}
          onChange={e=>go(e.target.files[0])}/>
        {piece.imageDataURL?(
          <>
            <img src={piece.imageDataURL} alt="" style={{maxHeight:38,maxWidth:'100%',objectFit:'contain',borderRadius:3}}/>
            <span style={{color:C.gr,fontSize:9,fontFamily:'monospace'}}>
              {isSVGfile?'⬡ vetor':'▣ raster'} · {piece.imageName?.slice(0,22)}
            </span>
          </>
        ):(
          <>
            <span style={{fontSize:18,opacity:.3}}>🖼</span>
            <span style={{color:C.mut,fontSize:9,fontFamily:'monospace'}}>SVG · PNG · JPG</span>
            <span style={{color:C.dim,fontSize:8,fontFamily:'monospace'}}>clique ou arraste</span>
          </>
        )}
      </div>
      {/* Hint de DPI/pixels — aparece quando DPI é detectado ou desconhecido */}
      {piece.hint&&(
        <div style={{
          fontSize:8,fontFamily:'monospace',padding:'3px 6px',borderRadius:3,marginBottom:8,
          color: piece.hint.includes('não encontrado')?'#d29922':'#3a5268',
          background: piece.hint.includes('não encontrado')?'#1a1000':'#060e14',
          border:`1px solid ${piece.hint.includes('não encontrado')?'#d2992244':'#1a2535'}`
        }}>{piece.hint}</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  APP
// ═══════════════════════════════════════════════════════════
export default function App(){
  const[rollW,setRollW]=useState(500),[pinch,setPinch]=useState(10),[buf,setBuf]=useState(3);
  const[rot,setRot]=useState(true),[mode,setMode]=useState('compaction');
  const[ran,setRan]=useState(false),[result,setResult]=useState(null),[passes,setPasses]=useState(0);
  const[showExport,setShowExport]=useState(false);
  const[pieces,setPieces]=useState([
    {id:1,label:'Arte 1',w:0,h:0,qty:1,client:'Cliente A',imageDataURL:null,imageName:null,svgRaw:null,hint:''},
    {id:2,label:'Arte 2',w:0,h:0,qty:1,client:'Cliente B',imageDataURL:null,imageName:null,svgRaw:null,hint:''},
  ]);
  const usableW=rollW-pinch*2;
  const upd=(id,f)=>setPieces(ps=>ps.map(p=>p.id===id?{...p,...f}:p));
  const add=()=>setPieces(ps=>[...ps,{id:Date.now(),label:`Arte ${ps.length+1}`,w:0,h:0,qty:1,client:'',imageDataURL:null,imageName:null,svgRaw:null,hint:''}]);
  const del=id=>{setPieces(ps=>ps.filter(p=>p.id!==id));setRan(false);};
  const calc=()=>{
    const r=nest(pieces,usableW,buf,rot,mode==='client');
    setResult(r);setRan(true);setPasses(mode==='client'?2:6);setShowExport(false);
  };
  const st=result?calcStats(result.placed,usableW,result.totalH):null;
  const allOk=pieces.every(p=>N(p.w)>0&&N(p.h)>0);
  const totalPcs=pieces.reduce((s,p)=>s+(parseInt(p.qty)||1),0);
  const ML={compaction:'⬛ Compactação',client:'👥 Por Cliente',scrap:'✂️ Retalho'};
  const fname=`nestcut_${rollW}x${result?.totalH.toFixed(0)}mm`;
  const doFull  =()=>{if(!result)return;dlSVG(makeSVGFull  (result.placed,result.totalH,rollW,usableW,pinch,buf,ML[mode]),`${fname}_artes.svg`);setShowExport(false);};
  const doLayout=()=>{if(!result)return;dlSVG(makeSVGLayout(result.placed,result.totalH,rollW,usableW,pinch,buf,ML[mode]),`${fname}_layout.svg`);setShowExport(false);};

  const C={bg:'#060a10',su:'#090e18',pa:'#0b1220',bo:'#162230',ac:'#FF6B35',bl:'#3a8fff',gr:'#3fb950',re:'#f85149',ye:'#d29922',mu:'#3a5268',tx:'#b5c5d5',di:'#5a7888',mo:"'Courier New',monospace"};
  const I={background:'#05101e',border:`1px solid ${C.bo}`,borderRadius:4,color:C.tx,fontFamily:C.mo,fontSize:12,padding:'5px 8px',outline:'none',width:'100%',boxSizing:'border-box'};
  const MB=on=>({background:on?C.ac+'28':'transparent',border:`1px solid ${on?C.ac:C.bo}`,borderRadius:4,color:on?C.ac:C.di,fontFamily:C.mo,fontSize:10,fontWeight:on?'bold':'normal',padding:'5px 11px',cursor:'pointer'});

  return(
    <div style={{background:C.bg,height:'100vh',color:C.tx,fontFamily:C.mo,display:'flex',flexDirection:'column',fontSize:12,overflow:'hidden'}}
      onClick={()=>showExport&&setShowExport(false)}>

      {/* Header */}
      <div style={{background:C.su,borderBottom:`1px solid ${C.bo}`,padding:'8px 18px',display:'flex',alignItems:'center',gap:12,flexShrink:0}}>
        <div style={{display:'flex',alignItems:'center',gap:7}}>
          <div style={{width:7,height:7,background:C.ac,borderRadius:'50%',boxShadow:`0 0 10px ${C.ac}`}}/>
          <span style={{color:C.ac,fontSize:14,fontWeight:'bold',letterSpacing:3}}>NESTCUT</span>
        </div>
        <span style={{color:C.mu,fontSize:10}}>MaxRects · Transfer / Power Film / DTF</span>
        <div style={{marginLeft:'auto',display:'flex',gap:5}}>
          {Object.entries(ML).map(([k,v])=><button key={k} onClick={()=>{setMode(k);setRan(false);}} style={MB(mode===k)}>{v}</button>)}
        </div>
      </div>

      <div style={{display:'flex',flex:1,overflow:'hidden'}}>
        {/* Sidebar Esquerda */}
        <div style={{width:252,background:C.su,borderRight:`1px solid ${C.bo}`,display:'flex',flexDirection:'column',flexShrink:0}}>
          <div style={{padding:'12px 12px 0'}}>
            <div style={{color:C.bl,fontSize:9,letterSpacing:2,marginBottom:9}}>◼ ROLO</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:7,marginBottom:8}}>
              {[['Largura mm',rollW,setRollW],['Pinca mm',pinch,setPinch],['Buffer mm',buf,setBuf]].map(([l,v,s])=>(
                <div key={l}><div style={{color:C.mu,fontSize:9,marginBottom:2}}>{l}</div><Num value={v} onChange={s} style={I} ph="0"/></div>
              ))}
              <div><div style={{color:C.mu,fontSize:9,marginBottom:2}}>Util mm</div><div style={{...I,color:C.bl,cursor:'default'}}>{usableW}</div></div>
            </div>
            <label style={{display:'flex',alignItems:'center',gap:7,marginBottom:10,cursor:'pointer',padding:'7px 9px',background:rot?'#0a1f0a':'#060e14',border:`1px solid ${rot?C.gr:C.bo}`,borderRadius:5}}>
              <input type="checkbox" checked={rot} onChange={e=>setRot(e.target.checked)} style={{accentColor:C.gr,width:13,height:13}}/>
              <div>
                <div style={{color:rot?C.gr:C.di,fontSize:10,fontWeight:'bold'}}>Rotacao 90° ativada</div>
                <div style={{color:C.mu,fontSize:8,marginTop:1}}>Imagem gira junto · proporcoes preservadas</div>
              </div>
            </label>
          </div>

          <div style={{flex:1,overflowY:'auto',padding:'0 12px'}}>
            <div style={{color:C.bl,fontSize:9,letterSpacing:2,marginBottom:9}}>◼ ARTES — {pieces.length} tipo{pieces.length!==1?'s':''} · {totalPcs} unid.</div>
            {pieces.map((p,pi)=>(
              <div key={p.id} style={{background:C.pa,border:`1px solid ${C.bo}`,borderRadius:7,padding:9,marginBottom:9}}>
                <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:7}}>
                  <div style={{width:8,height:8,background:PAL[pi%PAL.length],borderRadius:2,flexShrink:0}}/>
                  <input value={p.label} onChange={e=>upd(p.id,{label:e.target.value})}
                    style={{...I,background:'transparent',border:'none',fontWeight:'bold',fontSize:11,color:C.tx,padding:0,flex:1}}/>
                  {pieces.length>1&&<button onClick={()=>del(p.id)} style={{background:'none',border:'none',color:C.re,cursor:'pointer',fontSize:17,padding:0,lineHeight:1,opacity:.7}}>×</button>}
                </div>
                <Uploader piece={p} onUpdate={f=>upd(p.id,f)}/>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:5,marginBottom:6}}>
                  {[['L mm','w'],['A mm','h'],['Qtd.','qty']].map(([l,f])=>(
                    <div key={f}><div style={{color:C.mu,fontSize:9,marginBottom:2}}>{l}</div>
                    <Num value={p[f]} onChange={v=>upd(p.id,{[f]:v})}
                      style={{...I,padding:'4px 5px',textAlign:'center',borderColor:f!=='qty'&&N(p[f])===0?'#3a2200':C.bo}} ph="0"/></div>
                  ))}
                </div>
                {(N(p.w)===0||N(p.h)===0)&&<div style={{color:C.ye,fontSize:9,border:`1px solid ${C.ye}44`,borderRadius:3,padding:'3px 7px',marginBottom:5}}>⚠ Insira L e A</div>}
                <div><div style={{color:C.mu,fontSize:9,marginBottom:2}}>Cliente</div>
                <input style={{...I,padding:'4px 6px'}} value={p.client} onChange={e=>upd(p.id,{client:e.target.value})}/></div>
              </div>
            ))}
            <button onClick={add} style={{width:'100%',background:'transparent',border:`1px dashed ${C.bo}`,borderRadius:6,color:C.mu,fontFamily:C.mo,fontSize:11,padding:'8px 0',cursor:'pointer',marginBottom:12}}>+ Adicionar Arte</button>
          </div>

          <div style={{padding:12,borderTop:`1px solid ${C.bo}`}}>
            {!allOk&&<div style={{color:C.ye,fontSize:9,marginBottom:7,textAlign:'center'}}>Preencha L e A de todas as artes</div>}
            <button onClick={calc} disabled={!allOk} style={{width:'100%',background:allOk?C.ac:'#0e1824',border:`1px solid ${allOk?C.ac:C.bo}`,color:allOk?'#fff':C.mu,fontFamily:C.mo,fontSize:13,fontWeight:'bold',padding:'10px 0',borderRadius:5,cursor:allOk?'pointer':'not-allowed',letterSpacing:1,boxShadow:allOk?`0 0 20px ${C.ac}55`:'none'}}>
              ▶ CALCULAR NESTING
            </button>
            {ran&&passes>0&&<div style={{color:C.di,fontSize:8,marginTop:6,textAlign:'center'}}>✓ {passes} ordens testadas · melhor resultado</div>}
          </div>
        </div>

        {/* Centro */}
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',background:C.bg}}>
          {ran&&result&&(
            <div style={{background:C.su,borderBottom:`1px solid ${C.bo}`,padding:'7px 16px',display:'flex',gap:8,alignItems:'center',flexShrink:0}}>
              <span style={{color:C.mu,fontSize:10}}>
                <span style={{color:C.ac}}>{ML[mode]}</span>
                {' · '}{result.placed.length} pecas · {result.totalH.toFixed(0)}mm · {(result.totalH/1000).toFixed(3)}m
              </span>
              <div style={{marginLeft:'auto',position:'relative'}}>
                <button onClick={e=>{e.stopPropagation();setShowExport(v=>!v);}}
                  style={{background:'#06182e',border:`1px solid ${C.bl}`,borderRadius:5,color:C.bl,fontFamily:C.mo,fontSize:11,fontWeight:'bold',padding:'6px 18px',cursor:'pointer',display:'flex',alignItems:'center',gap:7}}>
                  ↓ Exportar SVG <span style={{fontSize:9,opacity:.7}}>▾</span>
                </button>
                {showExport&&(
                  <div onClick={e=>e.stopPropagation()} style={{position:'absolute',top:'calc(100% + 6px)',right:0,background:'#0c1828',border:`1px solid ${C.bo}`,borderRadius:8,overflow:'hidden',boxShadow:'0 8px 24px #000a',zIndex:100,minWidth:290}}>
                    <button onClick={doFull} style={{width:'100%',background:'none',border:'none',padding:'14px 16px',cursor:'pointer',textAlign:'left',borderBottom:`1px solid ${C.bo}`}}>
                      <div style={{display:'flex',alignItems:'center',gap:10}}>
                        <div style={{width:32,height:32,background:'#0a2040',borderRadius:6,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,flexShrink:0}}>🖼</div>
                        <div>
                          <div style={{color:C.tx,fontFamily:C.mo,fontSize:11,fontWeight:'bold',marginBottom:3}}>SVG com Artes</div>
                          <div style={{color:C.mu,fontFamily:C.mo,fontSize:9,lineHeight:1.5}}>
                            Artes em escala 1:1 · sem textos ou grades<br/>
                            <span style={{color:C.gr}}>SVG vetor</span> → paths preservados para corte<br/>
                            <span style={{color:C.ye}}>PNG/JPG</span> → imagem base64 para DTF
                          </div>
                        </div>
                      </div>
                    </button>
                    <button onClick={doLayout} style={{width:'100%',background:'none',border:'none',padding:'14px 16px',cursor:'pointer',textAlign:'left'}}>
                      <div style={{display:'flex',alignItems:'center',gap:10}}>
                        <div style={{width:32,height:32,background:'#0a1a2e',borderRadius:6,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,flexShrink:0}}>⬜</div>
                        <div>
                          <div style={{color:C.tx,fontFamily:C.mo,fontSize:11,fontWeight:'bold',marginBottom:3}}>SVG Layout (Caixas)</div>
                          <div style={{color:C.mu,fontFamily:C.mo,fontSize:9,lineHeight:1.5}}>
                            Bounding boxes com coordenadas e dimensoes<br/>
                            Grade, réguas e margem de pinça incluídas<br/>
                            Guia de montagem e referência de posição
                          </div>
                        </div>
                      </div>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          <div style={{flex:1,overflow:'hidden',display:'flex',flexDirection:'column',padding:ran?'10px 14px 6px':'0'}}>
            {!ran?(
              <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100%',gap:14}}>
                <div style={{fontSize:58,opacity:.09}}>⬛</div>
                <div style={{color:C.mu,fontSize:13}}>{allOk?'Pronto — clique em CALCULAR NESTING':'Configure as artes com suas dimensoes'}</div>
                <div style={{color:C.di,fontSize:10,maxWidth:360,textAlign:'center',lineHeight:1.8,opacity:.7}}>
                  SVG com unidades mm/cm/in/pt detectadas automaticamente.<br/>
                  PNG/JPG: DPI lido do arquivo · sem DPI: insira L e A manualmente.
                </div>
              </div>
            ):(
              <>
                <div style={{display:'flex',gap:12,flexWrap:'wrap',marginBottom:8,alignItems:'center',padding:'5px 0',borderBottom:`1px solid ${C.bo}`}}>
                  {pieces.map((p,pi)=>(
                    <span key={p.id} style={{display:'flex',alignItems:'center',gap:4,fontSize:10}}>
                      <span style={{width:9,height:9,background:PAL[pi%PAL.length],borderRadius:2,display:'inline-block'}}/>
                      {p.label} x{parseInt(p.qty)||1}
                      {p.svgRaw&&<span style={{color:C.gr,fontSize:8}}>⬡</span>}
                      {p.imageDataURL&&!p.svgRaw&&<span style={{color:C.ye,fontSize:8}}>▣</span>}
                    </span>
                  ))}
                  <span style={{marginLeft:'auto',color:C.di,fontSize:9}}>{rollW}mm · util {usableW}mm · buf {buf}mm{rot?' · ↻':''}</span>
                </div>
                {result&&<Canvas placed={result.placed} totalH={result.totalH} rollW={rollW} usableW={usableW} pinch={pinch} buf={buf}/>}
                <div style={{borderTop:`1px solid ${C.bo}`,paddingTop:6,marginTop:4,display:'flex',gap:8,flexWrap:'wrap',maxHeight:52,overflowY:'auto'}}>
                  {result.placed.map(p=>{
                    const pi=pieces.findIndex(x=>x.id===p.id);
                    return(
                      <div key={p.iid} style={{fontSize:9,color:C.di,whiteSpace:'nowrap'}}>
                        <span style={{color:PAL[pi>=0?pi%PAL.length:0]}}>■</span>
                        {' '}{p.label}{parseInt(p.qty)>1?` #${p.idx+1}`:''}{p.rotated?' ↻':''}
                        {' '}<span style={{color:'#405868'}}>X{p.x.toFixed(0)} Y{p.y.toFixed(0)} {N(p.w).toFixed(0)}x{N(p.h).toFixed(0)}mm</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Sidebar Direita */}
        <div style={{width:192,background:C.su,borderLeft:`1px solid ${C.bo}`,padding:14,overflowY:'auto',flexShrink:0}}>
          <div style={{color:C.bl,fontSize:9,letterSpacing:2,marginBottom:12}}>◼ AUDITORIA</div>
          {!st?<div style={{color:C.mu,fontSize:10}}>Execute o calculo.</div>:(
            <>
              <div style={{marginBottom:14}}>
                <div style={{color:C.mu,fontSize:9,marginBottom:4}}>APROVEITAMENTO</div>
                <div style={{fontSize:36,fontWeight:'bold',lineHeight:1,color:st.util>75?C.gr:st.util>50?C.ye:C.re}}>{st.util.toFixed(1)}%</div>
                <div style={{background:'#05101e',borderRadius:3,height:6,marginTop:8,overflow:'hidden'}}>
                  <div style={{width:`${Math.min(100,st.util)}%`,height:'100%',background:`linear-gradient(90deg,${C.gr},${C.bl})`,transition:'width .7s'}}/>
                </div>
              </div>
              <div style={{marginBottom:12,paddingBottom:12,borderBottom:`1px solid ${C.bo}`}}>
                <div style={{color:C.mu,fontSize:9,marginBottom:2}}>DESPERDICIO</div>
                <div style={{fontSize:22,fontWeight:'bold',color:C.ye}}>{st.waste.toFixed(1)}%</div>
              </div>
              {[['METRAGEM',`${st.lm.toFixed(3)} m`],['ALTURA',`${result.totalH.toFixed(0)} mm`],['AREA USADA',`${st.u.toFixed(0)} mm2`],['AREA TOTAL',`${st.t.toFixed(0)} mm2`],['PECAS',`${result.placed.length}`],['ROTACIONADAS',`${result.placed.filter(p=>p.rotated).length}`]].map(([l,v])=>(
                <div key={l} style={{marginBottom:9,paddingBottom:9,borderBottom:`1px solid ${C.bo}`}}>
                  <div style={{color:C.mu,fontSize:8}}>{l}</div>
                  <div style={{color:C.tx,fontSize:12,fontWeight:'bold',marginTop:2}}>{v}</div>
                </div>
              ))}
              <div style={{color:C.bl,fontSize:9,letterSpacing:2,marginBottom:8,marginTop:4}}>◼ POSICOES</div>
              {result.placed.map(p=>{
                const pi=pieces.findIndex(x=>x.id===p.id);
                return(
                  <div key={p.iid} style={{marginBottom:6,fontSize:9,borderBottom:`1px solid ${C.bo}22`,paddingBottom:4}}>
                    <div style={{color:PAL[pi>=0?pi%PAL.length:0],fontWeight:'bold'}}>{p.label}{parseInt(p.qty)>1?` #${p.idx+1}`:''}{p.rotated?' ↻':''}</div>
                    <div style={{color:C.di}}>X:{p.x.toFixed(0)} Y:{p.y.toFixed(0)}</div>
                    <div style={{color:C.di}}>{N(p.w).toFixed(0)}x{N(p.h).toFixed(0)}mm</div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
