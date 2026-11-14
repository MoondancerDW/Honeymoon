import org.lwjgl.opengl.GL11;

// 1.4.7 Tessellator boundary: ModelBox uses one GL quad per draw call.
public class baz {
    public static final baz a = new baz();
    private double[] positions;
    private double[] uv;
    private int vertex;

    public void b() {
        positions = new double[12];
        uv = new double[8];
        vertex = 0;
    }

    public void b(float nx, float ny, float nz) {}

    public void a(double x, double y, double z, double u, double v) {
        positions[vertex * 3] = x;
        positions[vertex * 3 + 1] = y;
        positions[vertex * 3 + 2] = z;
        uv[vertex * 2] = u;
        uv[vertex * 2 + 1] = v;
        vertex++;
    }

    public int a() {
        if (vertex != 4) throw new IllegalStateException("Expected a quad, got " + vertex + " vertices");
        GL11.submitQuad(positions, uv);
        return 0;
    }
}
