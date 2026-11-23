import{n as e}from"./mermaid-parser.core-CtOSohw1.js";import{n as t}from"./chunk-Y2CYZVJY-DsF7k-Jl.js";import{m as n}from"./src-qfWl0ROu.js";import{H as r,K as i,U as a,a as o,c as s,f as c,v as l,w as u,x as d,y as f}from"./chunk-DU6HZSFF-BGkxckb_.js";import{t as p}from"./ordinal-BDEzSJ7C.js";import{n as m}from"./path-fybaL0A-.js";import{m as h}from"./dist-v5Q1xZ2K.js";import{t as g}from"./arc-CQnQJ-Sg.js";import{t as _}from"./array-BifhSqXX.js";import{i as v,p as y}from"./chunk-75Z2AOVW-CTvs_YTX.js";import{t as b}from"./chunk-JWPE2WC7-CEzeTtJC.js";import{f as x}from"./mermaid.core-QNt0UASp.js";function S(e,t){return t<e?-1:t>e?1:t>=e?0:NaN}function C(e){return e}function w(){var e=C,t=S,n=null,r=m(0),i=m(h),a=m(0);function o(o){var s,c=(o=_(o)).length,l,u,d=0,f=Array(c),p=Array(c),m=+r.apply(this,arguments),g=Math.min(h,Math.max(-h,i.apply(this,arguments)-m)),v,y=Math.min(Math.abs(g)/c,a.apply(this,arguments)),b=y*(g<0?-1:1),x;for(s=0;s<c;++s)(x=p[f[s]=s]=+e(o[s],s,o))>0&&(d+=x);for(t==null?n!=null&&f.sort(function(e,t){return n(o[e],o[t])}):f.sort(function(e,n){return t(p[e],p[n])}),s=0,u=d?(g-c*b)/d:0;s<c;++s,m=v)l=f[s],x=p[l],v=m+(x>0?x*u:0)+b,p[l]={data:o[l],index:s,value:x,startAngle:m,endAngle:v,padAngle:y};return p}return o.value=function(t){return arguments.length?(e=typeof t==`function`?t:m(+t),o):e},o.sortValues=function(e){return arguments.length?(t=e,n=null,o):t},o.sort=function(e){return arguments.length?(n=e,t=null,o):n},o.startAngle=function(e){return arguments.length?(r=typeof e==`function`?e:m(+e),o):r},o.endAngle=function(e){return arguments.length?(i=typeof e==`function`?e:m(+e),o):i},o.padAngle=function(e){return arguments.length?(a=typeof e==`function`?e:m(+e),o):a},o}var T=c.pie,E={sections:new Map,showData:!1,config:T},D=E.sections,O=E.showData,k=structuredClone(T),A={getConfig:t(()=>structuredClone(k),`getConfig`),clear:t(()=>{D=new Map,O=E.showData,o()},`clear`),setDiagramTitle:i,getDiagramTitle:u,setAccTitle:a,getAccTitle:f,setAccDescription:r,getAccDescription:l,addSection:t(({label:e,value:t})=>{if(t<0)throw Error(`"${e}" has invalid value: ${t}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);D.has(e)||(D.set(e,t),n.debug(`added new section: ${e}, with value: ${t}`))},`addSection`),getSections:t(()=>D,`getSections`),setShowData:t(e=>{O=e},`setShowData`),getShowData:t(()=>O,`getShowData`)},j=t((e,t)=>{b(e,t),t.setShowData(e.showData),e.sections.map(t.addSection)},`populateDb`),M={parse:t(async t=>{let r=await e(`pie`,t);n.debug(r),j(r,A)},`parse`)},N=t(e=>`
  .pieCircle{
    stroke: ${e.pieStrokeColor};
    stroke-width : ${e.pieStrokeWidth};
    opacity : ${e.pieOpacity};
  }
  .pieCircle.highlighted{
    scale: 1.05;
    opacity: 1;
  }
  .pieCircle.highlightedOnHover:hover{
    transition-duration: 250ms;
    scale: 1.05;
    opacity: 1;
  }
  .pieOuterCircle{
    stroke: ${e.pieOuterStrokeColor};
    stroke-width: ${e.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${e.pieTitleTextSize};
    fill: ${e.pieTitleTextColor};
    font-family: ${e.fontFamily};
  }
  .slice {
    font-family: ${e.fontFamily};
    fill: ${e.pieSectionTextColor};
    font-size:${e.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${e.pieLegendTextColor};
    font-family: ${e.fontFamily};
    font-size: ${e.pieLegendTextSize};
  }
`,`getStyles`),P=t(e=>{let t=[...e.values()].reduce((e,t)=>e+t,0),n=[...e.entries()].map(([e,t])=>({label:e,value:t})).filter(e=>e.value/t*100>=1);return w().value(e=>e.value).sort(null)(n)},`createPieArcs`),F={parser:M,db:A,renderer:{draw:t((e,t,r,i)=>{var a;n.debug(`rendering pie chart
`+e);let o=i.db,c=d(),l=v(o.getConfig(),c.pie),u=x(t),f=u.append(`g`);f.attr(`transform`,`translate(225,225)`);let{themeVariables:m}=c,[h]=y(m.pieOuterStrokeWidth);h??(h=2);let _=l.legendPosition,b=l.textPosition,S=l.donutHole>0&&l.donutHole<=.9?l.donutHole:0,C=g().innerRadius(S*185).outerRadius(185),w=g().innerRadius(185*b).outerRadius(185*b),T=f.append(`g`);T.append(`circle`).attr(`cx`,0).attr(`cy`,0).attr(`r`,185+h/2).attr(`class`,`pieOuterCircle`);let E=o.getSections(),D=P(E),O=[m.pie1,m.pie2,m.pie3,m.pie4,m.pie5,m.pie6,m.pie7,m.pie8,m.pie9,m.pie10,m.pie11,m.pie12],k=0;E.forEach(e=>{k+=e});let A=D.filter(e=>(e.data.value/k*100).toFixed(0)!==`0`),j=p(O).domain([...E.keys()]);T.selectAll(`mySlices`).data(A).enter().append(`path`).attr(`d`,C).attr(`fill`,e=>j(e.data.label)).attr(`class`,e=>{let t=`pieCircle`;return l.highlightSlice===`hover`?t+=` highlightedOnHover`:l.highlightSlice===e.data.label&&(t+=` highlighted`),t}),T.selectAll(`mySlices`).data(A).enter().append(`text`).text(e=>(e.data.value/k*100).toFixed(0)+`%`).attr(`transform`,e=>`translate(`+w.centroid(e)+`)`).style(`text-anchor`,`middle`).attr(`class`,`slice`);let M=f.append(`text`).text(o.getDiagramTitle()).attr(`x`,0).attr(`y`,-200).attr(`class`,`pieTitleText`),N=[...E.entries()].map(([e,t])=>({label:e,value:t})),F=f.selectAll(`.legend`).data(N).enter().append(`g`).attr(`class`,`legend`);F.append(`rect`).attr(`width`,18).attr(`height`,18).style(`fill`,e=>j(e.label)).style(`stroke`,e=>j(e.label)),F.append(`text`).attr(`x`,22).attr(`y`,14).text(e=>o.getShowData()?`${e.label} [${e.value}]`:e.label);let I=Math.max(...F.selectAll(`text`).nodes().map(e=>(e==null?void 0:e.getBoundingClientRect().width)??0)),L=450,R=490,z=N.length*22;switch(_){case`center`:F.attr(`transform`,(e,t)=>{let n=22*N.length/2,r=-I/2-22,i=t*22-n;return`translate(`+r+`,`+i+`)`});break;case`top`:L+=z,F.attr(`transform`,(e,t)=>`translate(${-I/2-22}, ${t*22-185})`),T.attr(`transform`,()=>`translate(0, ${z+22})`);break;case`bottom`:L+=z,F.attr(`transform`,(e,t)=>{let n=-I/2-22,r=t*22- -207;return`translate(`+n+`,`+r+`)`});break;case`left`:R+=22+I,F.attr(`transform`,(e,t)=>{let n=22*N.length/2;return`translate(-207,`+(t*22-n)+`)`}),T.attr(`transform`,()=>`translate(${I+18+4}, 0)`);break;default:R+=22+I,F.attr(`transform`,(e,t)=>{let n=22*N.length/2;return`translate(216,`+(t*22-n)+`)`})}let B=((a=M.node())==null?void 0:a.getBoundingClientRect().width)??0,V=225-B/2,H=225+B/2,U=Math.min(0,V),W=Math.max(R,H)-U;u.attr(`viewBox`,`${U} 0 ${W} ${L}`),s(u,L,W,l.useMaxWidth)},`draw`)},styles:N};export{F as diagram};