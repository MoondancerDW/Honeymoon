// World used by a single-cell tile renderer and collision query.
public class yc implements ym {
    int metadata;
    int blockId;

    public int h(int x, int y, int z) {
        return metadata;
    }

    public int a(int x, int y, int z) {
        return blockId;
    }

    public any q(int x, int y, int z) { throw unsupported(); }
    public int i(int x, int y, int z, int light) { throw unsupported(); }
    public float j(int x, int y, int z, int light) { throw unsupported(); }
    public float p(int x, int y, int z) { throw unsupported(); }
    public agi g(int x, int y, int z) { throw unsupported(); }
    public boolean s(int x, int y, int z) { throw unsupported(); }
    public boolean t(int x, int y, int z) { throw unsupported(); }
    public boolean c(int x, int y, int z) { throw unsupported(); }
    public yy a(int x, int z) { throw unsupported(); }
    public int O() { throw unsupported(); }
    public boolean Q() { throw unsupported(); }
    public boolean v(int x, int y, int z) { throw unsupported(); }
    public aok S() { throw unsupported(); }
    public boolean k(int x, int y, int z, int side) { throw unsupported(); }

    private static UnsupportedOperationException unsupported() {
        return new UnsupportedOperationException("Unexpected world query during model capture");
    }
}
