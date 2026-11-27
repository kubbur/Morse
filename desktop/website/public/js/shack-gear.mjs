import { equipment } from './shack-model.mjs';

// Equipment portraits share a fixed pixel grid so a moved item keeps its silhouette in either window.
export function drawGear(canvas) {
  const item=equipment(canvas.dataset.portrait);
  const c=canvas.getContext('2d');
  if (!item || !c) return;
  const {slot,level}=item;
  const metal=['#aab6a1','#9aada5','#b9c9a4','#c6b895','#bec9be','#ddc991'][level];
  const rect=(x,y,w,h,color)=>{c.fillStyle=color;c.fillRect(x,y,w,h);};
  const shape=(points,color)=>{
    c.fillStyle=color;c.beginPath();c.moveTo(...points[0]);
    for (const [x,y] of points.slice(1)) c.lineTo(x,y);
    c.closePath();c.fill();
  };
  const line=(x,y,x2,y2,color,width=1.4)=>{c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.moveTo(x,y);c.lineTo(x2,y2);c.stroke();};
  const disc=(x,y,r,color)=>{c.fillStyle=color;c.beginPath();c.arc(x,y,r,0,Math.PI*2);c.fill();};
  const deck=(x,y,w,h,color)=>{
    shape([[x,y],[x+10,y-7],[x+w+10,y-7],[x+w,y]],color);
    rect(x,y,w,h,'#49534d');shape([[x+w,y],[x+w+10,y-7],[x+w+10,y+h-7],[x+w,y+h]],'#344039');
  };
  canvas.width=144;canvas.height=72;c.imageSmoothingEnabled=false;
  c.fillStyle='#10191455';c.beginPath();c.ellipse(74,59,54,4,0,0,Math.PI*2);c.fill();
  if (slot===0) {
    deck(21,49,90,6,level===5?'#997c53':'#69766b');
    if (level<2) {
      rect(45,28,10,18,metal);rect(59,23,5,21,'#98a887');
      line(36,35,103,23,metal,4);disc(49,32,5,'#37443a');disc(49,32,2,'#dccaa1');
      rect(90,20,14,7,'#2e3c31');disc(100,20,7,level===0?'#52644e':'#c7b280');
      for(let i=0;i<4;i++)line(66+i,33,69+i,42,'#9f9e81',1);
      rect(36,40,5,7,'#d2c38d');rect(66,41,7,4,'#cfb875');
    } else {
      deck(32,38,52,8,metal);
      [0,12].forEach((dy,n)=>{
        line(52,29+dy,98,29+dy,'#b8b897',3);disc(53,30+dy,4,'#d0b678');
        shape([[90,25+dy],[111,23+dy],[118,28+dy],[113,31+dy],[91,32+dy]],['#875f47','#bd8368','#759d87','#dec690'][level-2]);
        disc(41,33+dy,2,'#39463c');line(63,27+dy,70,27+dy,'#39463c',1);
      });
    }
  } else if (slot===1) {
    const x=level===3?32:18, w=level===3?74:99, top=23-(level%3)*2;
    deck(x,top,w,30,metal);
    rect(x+3,top+4,w-6,23,'#34443d');rect(x+9,top+7,level<2?30:39,10,'#acc987');
    for(let i=0;i<5;i++)rect(x+12+i*5,top+9,3,5,'#455b42');
    disc(x+w-18,top+15,10,'#212e28');disc(x+w-18,top+15,7,metal);line(x+w-18,top+15,x+w-15,top+10,'#445342',2);
    for(let i=0;i<Math.min(level+2,7);i++)rect(x+9+i*6,top+21,4,3,i%3===0?'#c4a47c':'#7e9283');
    for(let i=0;i<6;i++)line(x+11+i*7,top-2,x+16+i*7,top-5,'#526457',1);
    rect(x+5,top+30,9,3,'#27342c');rect(x+w-17,top+30,9,3,'#27342c');
  } else {
    const mast=level===3?79:72;
    line(mast,11,mast,55,metal,2);line(mast,54,mast-8,59,'#667a66');line(mast,54,mast+10,59,'#667a66');
    if(level<=2) {
      const apex=level===2?40:12;
      line(12,level===2?44:38,mast,apex,metal,1.5);line(mast,apex,131,level===2?12:38,metal,1.5);
      for(const x of [15,128])disc(x,level===2?(x===15?43:13):37,2,'#cbb985');
      if(level===1)for(const x of [41,101])disc(x,25,2.5,'#d8bb82');
      line(mast,apex,mast+4,55,'#708875',1);rect(mast-2,apex-2,5,4,'#d0bd89');
    } else if(level===3) {
      line(mast,8,mast,52,'#cbd3ae',3);for(const x of [35,54,105,120])line(mast,40,x,56,metal);
    } else {
      const levels=level===5?[13,32]:[21];
      for(const y of levels) {
        line(28,y+8,113,y-5,metal,2.4);
        for(let j=0;j<(level===5?7:4);j++){const x=32+j*(level===5?12:24),h=12-j*.7;line(x-h,y+8-j*2-h,x+h,y+8-j*2+h,'#b8c8a5',1.7);}
      }
      if(level===5){line(68,55,72,8,metal);line(77,55,72,8,metal);for(let y=30;y<54;y+=6)line(70,y,75,y+5,metal,1);}
    }
  }
}
