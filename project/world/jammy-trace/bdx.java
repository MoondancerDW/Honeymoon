import org.lwjgl.opengl.GL11;

// 1.4.7 TileEntitySpecialRenderer texture-binding boundary.
public abstract class bdx {
    public abstract void a(any tile, double x, double y, double z, float partialTicks);

    protected void a(String texture) {
        GL11.bindTexture(texture);
    }
}
