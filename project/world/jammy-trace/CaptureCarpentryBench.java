import org.lwjgl.opengl.GL11;
import java.util.StringJoiner;

/** Trace the standalone Custom NPCs carpentry bench renderer using the same capture boundary as Jammy. */
public final class CaptureCarpentryBench {
    public static void main(String[] args) throws Exception {
        bdx renderer = (bdx) Class.forName("noppes.npcs.items.renderer.BlockCarpentryBenchRenderer")
            .getDeclaredConstructor().newInstance();
        any tile = new any();
        tile.k = new yc();
        GL11.begin((texture, positions, uv) -> System.out.println(texture + "\t" + array(positions) + "\t" + array(uv)));
        renderer.a(tile, 0, 0, 0, 0);
        GL11.end();
    }

    private static String array(double[] values) {
        StringJoiner result = new StringJoiner(",");
        for (double value : values) result.add(Double.toString(value));
        return result.toString();
    }
}
