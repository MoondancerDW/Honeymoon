package org.lwjgl.opengl;

import java.util.ArrayDeque;
import java.util.Deque;

/** CPU matrix stack for offline model capture. No OpenGL context is created. */
public final class GL11 {
    private static final Deque<float[]> matrices = new ArrayDeque<float[]>();
    private static float[] matrix;
    public static final float[] color = new float[4];
    static { reset(); }

    public static void reset() {
        matrices.clear();
        matrix = identity();
        glColor4f(1, 1, 1, 1);
    }
    private static float[] identity() {
        return new float[]{1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1};
    }
    public static float[] matrix() { return matrix.clone(); }
    private static void multiply(float[] b) {
        float[] result = new float[16];
        for (int j=0;j<4;j++) for (int i=0;i<4;i++)
            for (int k=0;k<4;k++) result[i+4*j] += matrix[i+4*k]*b[k+4*j];
        matrix=result;
    }
    public static void glPushMatrix() { matrices.push(matrix.clone()); }
    public static void glPopMatrix() { matrix=matrices.pop(); }
    public static void glTranslatef(float x,float y,float z) {
        float[] n=identity();
        n[12]=x; n[13]=y; n[14]=z;
        multiply(n);
    }
    public static void glTranslated(double x,double y,double z) { glTranslatef((float)x,(float)y,(float)z); }
    public static void glScalef(float x,float y,float z) {
        float[] n=identity();
        n[0]=x;n[5]=y;n[10]=z;
        multiply(n);
    }
    public static void glScaled(double x,double y,double z) { glScalef((float)x,(float)y,(float)z); }
    public static void glRotatef(float angle,float x,float y,float z) {
        float magnitude=(float)Math.sqrt(x*x+y*y+z*z);
        if (magnitude==0) return;
        x/=magnitude;y/=magnitude;z/=magnitude;
        double radians=Math.toRadians(angle);
        float c=(float)Math.cos(radians),s=(float)Math.sin(radians),d=1-c;
        multiply(new float[]{c+x*x*d,y*x*d+z*s,z*x*d-y*s,0,
                x*y*d-z*s,c+y*y*d,z*y*d+x*s,0,
                x*z*d+y*s,y*z*d-x*s,c+z*z*d,0, 0,0,0,1});
    }
    public static void glRotated(double angle,double x,double y,double z) { glRotatef((float)angle,(float)x,(float)y,(float)z); }
    public static void glColor4f(float r,float g,float b,float a) { color[0]=r;color[1]=g;color[2]=b;color[3]=a; }
    public static void glColor3f(float r,float g,float b) { glColor4f(r,g,b,1); }
    public static void glEnable(int v) {}
    public static void glDisable(int v) {}
    public static void glCullFace(int v) {}
    public static void glBlendFunc(int a,int b) {}
    public static void glDepthMask(boolean enabled) {}
    public static void glAlphaFunc(int rule,float value) {}
    public static void glNormal3f(float x,float y,float z) {}
    public static void glBindTexture(int type,int texture) {}
}
