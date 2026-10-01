from PIL import Image, ImageDraw
BG=(31,41,51); AMBER=(245,166,35); PAPER=(244,245,242); BLUE=(29,78,137)
def draw(size, maskable=False):
    S=1024; im=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(im)
    if maskable: d.rectangle([0,0,S,S],fill=BG)
    else: d.rounded_rectangle([0,0,S-1,S-1],radius=220,fill=BG)
    m=0.68 if maskable else 0.78
    w=int(S*m); x0=(S-w)//2; y0=(S-int(w*0.78))//2; h=int(w*0.78)
    d.rounded_rectangle([x0,y0,x0+w,y0+h],radius=40,fill=PAPER)
    g=w//8
    for i in range(1,8):
        d.line([x0+i*g,y0+20,x0+i*g,y0+h-20],fill=(190,205,225),width=6)
    for j in range(1,6):
        yy=y0+j*(h//6); d.line([x0+20,yy,x0+w-20,yy],fill=(190,205,225),width=6)
    d.line([x0+w*0.14,y0+h*0.78,x0+w*0.5,y0+h*0.3,x0+w*0.86,y0+h*0.62],fill=BLUE,width=26,joint='curve')
    r=34
    for px,py in [(x0+w*0.14,y0+h*0.78),(x0+w*0.5,y0+h*0.3),(x0+w*0.86,y0+h*0.62)]:
        d.ellipse([px-r,py-r,px+r,py+r],fill=AMBER,outline=BG,width=8)
    return im.resize((size,size),Image.LANCZOS)
draw(512).save('icons/icon-512.png'); draw(192).save('icons/icon-192.png')
draw(512,True).save('icons/maskable-512.png')
a=draw(180,True).convert('RGB'); a.save('icons/apple-touch-icon.png')
