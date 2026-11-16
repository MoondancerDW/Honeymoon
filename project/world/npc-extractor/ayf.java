import java.util.ArrayList;
import java.util.List;
import org.lwjgl.opengl.GL11;

/** Binary-compatible geometry capture replacement for the 1.4.7 ModelRenderer. */
public class ayf {
    public float a=64,b=32;
    private int textureX,textureY;
    public float c,d,e,f,g,h;
    public boolean i,j=true,k;
    public List<Object> l=new ArrayList<Object>();
    public List<ayf> m;
    public final String n;
    private final axa model;
    public float o,p,q;

    public ayf(axa model,String name) {
        this.model=model;
        this.n=name;
        model.r.add(this);
        b(model.t,model.u);
    }
    public ayf(axa model) { this(model,(String)null); }
    public ayf(axa model,int x,int y) { this(model); a(x,y); }
    public void a(ayf child) {
        if (m==null) m=new ArrayList<ayf>();
        m.add(child);
    }
    public ayf a(int x,int y) {textureX=x;textureY=y;return this;}
    public ayf a(String name,float x,float y,float z,int w,int height,int depth) {
        String full=n+"."+name;
        ayg offset=model.a(full);
        a(offset.a,offset.b);
        l.add(new aya(this,textureX,textureY,x,y,z,w,height,depth,0).a(full));
        return this;
    }
    public ayf a(float x,float y,float z,int w,int height,int depth) {
        a(x,y,z,w,height,depth,0);return this;
    }
    public void a(float x,float y,float z,int w,int height,int depth,float padding) {
        l.add(new aya(this,textureX,textureY,x,y,z,w,height,depth,padding));
    }
    public void a(float x,float y,float z) {c=x;d=y;e=z;}
    private boolean visible() {return j && !k;}
    private static void x(float angle) {GL11.glRotatef((float)Math.toDegrees(angle),1,0,0);}
    private static void y(float angle) {GL11.glRotatef((float)Math.toDegrees(angle),0,1,0);}
    private static void z(float angle) {GL11.glRotatef((float)Math.toDegrees(angle),0,0,1);}
    private void pivot(float scale) {GL11.glTranslatef(c*scale,d*scale,e*scale);}
    public void a(float scale) {
        if (!visible()) return;
        GL11.glPushMatrix();
        GL11.glTranslatef(o,p,q);
        pivot(scale); z(h); y(g); x(f);
        NpcModelCapture.part(this,scale);
        if (m!=null) for(ayf child:m) child.a(scale);
        GL11.glPopMatrix();
    }
    public void b(float scale) {
        if (!visible()) return;
        GL11.glPushMatrix();
        pivot(scale);y(g);x(f);z(h);
        NpcModelCapture.part(this,scale);
        GL11.glPopMatrix();
    }
    public void c(float scale) {
        if (!visible()) return;
        pivot(scale);z(h);y(g);x(f);
    }
    public ayf b(int width,int height) { a=width;b=height;return this; }
}
