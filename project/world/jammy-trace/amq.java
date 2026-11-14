import java.util.List;

// Block's base AABB behavior. Jammy's bounds and collision overrides run unchanged.
public class amq {
    public final int cm;
    private final double[] bounds = new double[]{0, 0, 0, 1, 1, 1};

    protected amq(int id) {
        cm = id;
    }

    public amq r() {
        return this;
    }

    public amq a(float light) {
        return this;
    }

    public final void a(float x0, float y0, float z0, float x1, float y1, float z1) {
        bounds[0] = x0;
        bounds[1] = y0;
        bounds[2] = z0;
        bounds[3] = x1;
        bounds[4] = y1;
        bounds[5] = z1;
    }

    public aoe e(yc world, int x, int y, int z) {
        return at(x, y, z);
    }

    public void a(ym world, int x, int y, int z) {}

    public aoe b_(yc world, int x, int y, int z) {
        return at(x, y, z);
    }

    private aoe at(int x, int y, int z) {
        return aoe.a(bounds[0] + x, bounds[1] + y, bounds[2] + z,
            bounds[3] + x, bounds[4] + y, bounds[5] + z);
    }

    public void a(yc world, int x, int y, int z, aoe area, List<aoe> collisions, lq entity) {
        aoe collision = e(world, x, y, z);
        if (collision != null && area.a(collision)) collisions.add(collision);
    }
}
